import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DeviceTokensService } from './device-tokens.service';
import { DjangoUserPrefsClient } from './django-user-prefs.client';
import { createFcmProvider } from './fcm.provider';
import { createApnsVoipProvider, ApnsVoipProvider } from './apns-voip.provider';
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
  private readonly apnsVoip: ApnsVoipProvider | null;
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly tokens: DeviceTokensService,
    private readonly userPrefsClient: DjangoUserPrefsClient,
  ) {
    const fcm = createFcmProvider();
    if (!fcm) {
      this.logger.warn(
        'FCM provider not initialised - push notifications will be silently dropped. ' +
        'Set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_PATH to enable real delivery.',
      );
    }
    this.provider = fcm ?? new DummyPushProvider();

    this.apnsVoip = createApnsVoipProvider();
    if (!this.apnsVoip) {
      this.logger.warn(
        'APNs VoIP provider not initialised - incoming-call pushes will fall back to FCM only ' +
        '(no CallKit wake from killed state on iOS). Set APNS_KEY_PATH/APNS_KEY_BASE64, ' +
        'APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID to enable it.',
      );
    }
  }

  onModuleInit() {
    if (this.provider instanceof DummyPushProvider) {
      // error, not warn: this is a production-severity condition (every
      // push, including every incoming-call wake-up, silently no-ops) that
      // must not blend into routine warning-level log noise. Also surfaced
      // non-secretly via getProviderStatus()/the /health endpoint so it's
      // checkable without grepping logs.
      this.logger.error('Running with DummyPushProvider - no push notifications will be delivered. Check FCM_SERVICE_ACCOUNT_JSON/FCM_SERVICE_ACCOUNT_PATH.');
    }
  }

  /** Non-secret provider status for the /health endpoint - never expose
   * credential values, only whether each provider initialized. */
  getProviderStatus() {
    return {
      fcm_configured: !(this.provider instanceof DummyPushProvider),
      apns_voip_configured: this.apnsVoip !== null,
      active_push_provider: this.provider instanceof DummyPushProvider ? 'dummy' : 'fcm',
    };
  }

  async notify(target: PushTarget, msg: PushMessage, opts?: { retryOnTransientFailure?: boolean }) {
    const tokenList = target.deviceTokens?.length
      ? target.deviceTokens
      : await this.tokens.listActiveTokens(target.userId);

    if (!tokenList.length) {
      this.logger.log(`[notify] no active device tokens for userId=${target.userId} — nothing to send`);
      return { ok: true, delivered: 0, userId: target.userId };
    }

    // callId is only present on incoming-call/missed-call pushes — logging
    // it when available lets a specific call's push delivery be traced
    // end-to-end alongside the client-side diagnostics (callDiagnostics.ts).
    const callIdSuffix = msg.data?.callId ? ` callId=${msg.data.callId}` : ''
    const res = await this.provider.send(tokenList, msg);
    this.logger.log(
      `[notify] sent to userId=${target.userId}: tokens=${tokenList.length} delivered=${res.delivered} ` +
      `permanentFailures=${res.failedTokens?.length ?? 0} transientFailures=${res.transientTokens?.length ?? 0}${callIdSuffix}`,
    );

    // Prune permanently-invalid tokens returned by the provider
    if (res.failedTokens?.length) {
      await this.tokens.bulkDeactivate(res.failedTokens).catch(() => null);
    }

    // Bounded single retry, only for time-critical pushes (incoming calls)
    // that got NO delivery at all and failed for a non-permanent reason —
    // e.g. FCM having a transient blip, a rate limit, an unrecognized
    // error code. Never retried more than once, never for tokens already
    // known permanently invalid, so a bad FCM day degrades gracefully
    // instead of turning into a retry storm.
    if (opts?.retryOnTransientFailure && res.delivered === 0 && res.transientTokens?.length) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const retryRes = await this.provider.send(res.transientTokens, msg).catch((e: any) => {
        this.logger.warn(`[notify] retry attempt itself failed userId=${target.userId}: ${e?.message}`);
        return null;
      });
      if (retryRes) {
        this.logger.log(
          `[notify] retry for userId=${target.userId}: delivered=${retryRes.delivered} stillFailed=${retryRes.transientTokens?.length ?? 0}${callIdSuffix}`,
        );
        if (retryRes.failedTokens?.length) {
          await this.tokens.bulkDeactivate(retryRes.failedTokens).catch(() => null);
        }
        return { ok: true, delivered: res.delivered + retryRes.delivered, userId: target.userId };
      }
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

    // iOS: prefer a real PushKit VoIP push so CallKit can wake the app and
    // ring even when it's fully killed. Payload keys must match exactly what
    // AppDelegate.swift's PKPushRegistryDelegate reads (callId/callerName/callType).
    if (this.apnsVoip) {
      const voipTokens = await this.tokens.listActiveVoipTokens(input.toUserId).catch(() => []);
      if (voipTokens.length) {
        try {
          const res = await this.apnsVoip.sendVoip(voipTokens, {
            callId: input.callId,
            callerName: callerLabel,
            callType: input.callType ?? 'voice',
            conversationId: input.conversationId,
            fromUserId: input.fromUserId,
            type: 'incoming_call',
          });
          if (res.failedTokens.length) {
            await this.tokens.bulkDeactivate(res.failedTokens).catch(() => null);
          }
        } catch (e: any) {
          this.logger.warn(`VoIP push failed for userId=${input.toUserId}: ${e?.message}`);
        }
      }
    }

    // Also always send a regular FCM push - covers Android, and any iOS
    // device that hasn't registered a VoIP token yet. Incoming-call pushes
    // are the most time-critical/highest-stakes push type in the app (a
    // dropped one is a call that never rings), so this is the one place
    // that opts into the bounded transient-failure retry.
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
      { retryOnTransientFailure: true },
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
        this.logger.log(`[notify] skipped userId=${input.toUserId}: muted_category`);
        return { ok: true, delivered: 0, skipped: 'muted_category' };
      }
      const dnd = prefs.dnd_quiet_hours;
      if (dnd?.enabled && isInQuietHours(dnd)) {
        this.logger.log(`[notify] skipped userId=${input.toUserId}: dnd`);
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
