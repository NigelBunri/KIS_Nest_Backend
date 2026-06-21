import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DeviceTokensService } from './device-tokens.service';
import { DjangoUserPrefsClient } from './django-user-prefs.client';
import { createFcmProvider } from './fcm.provider';
import { DummyPushProvider, PushMessage, PushProvider } from './push.provider';

export type PushTarget = { userId: string; deviceTokens?: string[] };

function isInQuietHours(dnd: { start?: string; end?: string }): boolean {
  const now = new Date()
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
  const { start, end } = dnd
  if (!start || !end) return false
  // Handle overnight ranges (e.g. 22:00 → 07:00)
  if (start <= end) {
    return hhmm >= start && hhmm <= end
  }
  return hhmm >= start || hhmm <= end
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly provider: PushProvider;
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly tokens: DeviceTokensService,
    private readonly userPrefsClient: DjangoUserPrefsClient,
  ) {
    const fcm = createFcmProvider();
    if (!fcm) {
      this.logger.warn(
        'FCM provider not initialised — push notifications will be silently dropped. ' +
        'Set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_PATH to enable real delivery.',
      );
    }
    this.provider = fcm ?? new DummyPushProvider();
  }

  onModuleInit() {
    if (this.provider instanceof DummyPushProvider) {
      this.logger.warn('Running with DummyPushProvider — no push notifications will be delivered.');
    }
  }

  async notify(target: PushTarget, msg: PushMessage) {
    const tokenList = target.deviceTokens?.length
      ? target.deviceTokens
      : await this.tokens.listActiveTokens(target.userId);

    if (!tokenList.length) return { ok: true, delivered: 0, userId: target.userId };

    const res = await this.provider.send(tokenList, msg);

    // Prune permanently-invalid tokens returned by the provider
    if (res.failedTokens?.length) {
      await this.tokens.bulkDeactivate(res.failedTokens).catch(() => null);
    }

    return { ok: true, delivered: res.delivered, userId: target.userId };
  }

  async notifyIncomingCall(input: {
    toUserId: string;
    fromUserId: string;
    fromDisplayName?: string
    conversationId: string;
    callId: string;
    callType?: string;
    title?: string;
  }) {
    const prefs = await this.userPrefsClient.getNotificationPrefs(input.toUserId).catch(() => null);
    if (prefs?.notif_calls === false) {
      return { ok: true, delivered: 0, skipped: 'muted_category' };
    }
    const dnd = prefs?.dnd_quiet_hours;
    if (dnd?.enabled && isInQuietHours(dnd)) {
      return { ok: true, delivered: 0, skipped: 'dnd' };
    }

    const callerLabel = input.fromDisplayName || input.fromUserId;
    const callLabel = input.title || (input.callType ? `${input.callType} call` : 'call');

    return this.notify(
      { userId: input.toUserId },
      {
        title: `Incoming ${callLabel}`,
        body: `${callerLabel} is calling you`,
        data: {
          conversationId: input.conversationId,
          callId: input.callId,
          callType: input.callType ?? 'voice',
          fromUserId: input.fromUserId,
          type: 'incoming_call',
        },
      },
    );
  }

  async notifyMissedCall(input: {
    toUserId: string;
    fromUserId: string;
    fromDisplayName?: string;
    conversationId: string;
    callId: string;
    callType?: string;
  }) {
    const prefs = await this.userPrefsClient.getNotificationPrefs(input.toUserId).catch(() => null);
    if (prefs?.notif_calls === false) {
      return { ok: true, delivered: 0, skipped: 'muted_category' };
    }

    const callerLabel = input.fromDisplayName || input.fromUserId;
    return this.notify(
      { userId: input.toUserId },
      {
        title: 'Missed call',
        body: `You missed a ${input.callType ?? 'voice'} call from ${callerLabel}`,
        data: {
          conversationId: input.conversationId,
          callId: input.callId,
          fromUserId: input.fromUserId,
          type: 'missed_call',
        },
      },
    );
  }

  async notifyNewMessage(input: {
    toUserId: string;
    conversationId: string;
    messageId: string;
    preview?: string;
    senderName?: string;
    senderId?: string;
  }) {
    const prefs = await this.userPrefsClient.getNotificationPrefs(input.toUserId).catch(() => null);
    if (prefs) {
      if (prefs.notif_messages === false) {
        return { ok: true, delivered: 0, skipped: 'muted_category' };
      }
      const dnd = prefs.dnd_quiet_hours;
      if (dnd?.enabled && isInQuietHours(dnd)) {
        return { ok: true, delivered: 0, skipped: 'dnd' };
      }
    }

    const title = (input.senderName && String(input.senderName).trim()) || 'New message';
    const body = input.preview ?? 'New message';
    return this.notify(
      { userId: input.toUserId },
      {
        title,
        body,
        data: {
          conversationId: input.conversationId,
          messageId: input.messageId,
          senderId: input.senderId ?? '',
          type: 'message',
        },
      },
    );
  }

  async notifyStatusUpdate(input: {
    toUserId: string;
    authorName: string;
    statusId: string;
    preview?: string;
  }) {
    const prefs = await this.userPrefsClient.getNotificationPrefs(input.toUserId).catch(() => null);
    if (prefs?.notif_feed === false) {
      return { ok: true, delivered: 0, skipped: 'muted_category' };
    }
    const dnd = prefs?.dnd_quiet_hours;
    if (dnd?.enabled && isInQuietHours(dnd)) {
      return { ok: true, delivered: 0, skipped: 'dnd' };
    }

    const title = input.authorName ? `${input.authorName} posted a status` : 'New status update';
    return this.notify(
      { userId: input.toUserId },
      {
        title,
        body: input.preview ?? 'Tap to view',
        data: { statusId: input.statusId, type: 'status_update' },
      },
    );
  }

  async notifyHealthBookingUpdate(input: {
    toUserId: string;
    bookingId: string;
    eventType: 'confirmed' | 'cancelled' | 'reminder' | 'updated';
    providerName?: string;
    scheduledAt?: string;
  }) {
    const prefs = await this.userPrefsClient.getNotificationPrefs(input.toUserId).catch(() => null);
    if (prefs?.notif_health === false) {
      return { ok: true, delivered: 0, skipped: 'muted_category' };
    }
    const dnd = prefs?.dnd_quiet_hours;
    if (dnd?.enabled && isInQuietHours(dnd)) {
      return { ok: true, delivered: 0, skipped: 'dnd' };
    }

    const titles: Record<string, string> = {
      confirmed: 'Booking confirmed',
      cancelled: 'Booking cancelled',
      reminder: 'Upcoming appointment',
      updated: 'Booking updated',
    };
    const title = titles[input.eventType] ?? 'Booking update';
    const body = input.providerName
      ? `${input.providerName}${input.scheduledAt ? ' · ' + input.scheduledAt : ''}`
      : input.scheduledAt ?? 'Tap for details';
    return this.notify(
      { userId: input.toUserId },
      {
        title,
        body,
        data: { bookingId: input.bookingId, eventType: input.eventType, type: 'health_booking' },
      },
    );
  }
}
