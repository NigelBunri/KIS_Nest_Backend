import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DeviceTokensService } from './device-tokens.service';
import { createFcmProvider } from './fcm.provider';
import { DummyPushProvider, PushMessage, PushProvider } from './push.provider';

export type PushTarget = { userId: string; deviceTokens?: string[] };

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly provider: PushProvider;
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly tokens: DeviceTokensService,
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
    conversationId: string;
    callId: string;
  }) {
    return this.notify(
      { userId: input.toUserId },
      {
        title: 'Incoming call',
        body: `Call from ${input.fromUserId}`,
        data: { conversationId: input.conversationId, callId: input.callId, type: 'call' },
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
