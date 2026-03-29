import { Injectable } from '@nestjs/common';
import { DeviceTokensService } from './device-tokens.service';
import { createFcmProvider } from './fcm.provider';
import { DummyPushProvider, PushMessage, PushProvider } from './push.provider';

export type PushTarget = { userId: string; deviceTokens?: string[] };

@Injectable()
export class NotificationsService {
  private readonly provider: PushProvider;

  constructor(
    private readonly tokens: DeviceTokensService,
  ) {
    this.provider = createFcmProvider() ?? new DummyPushProvider();
  }

  async notify(target: PushTarget, msg: PushMessage) {
    const tokens = target.deviceTokens?.length
      ? target.deviceTokens
      : await this.tokens.listActiveTokens(target.userId);

    if (!tokens.length) return { ok: true, delivered: 0, userId: target.userId };

    const res = await this.provider.send(tokens, msg);
    return { ok: true, delivered: res.delivered, userId: target.userId };
  }

  async notifyIncomingCall(input: { toUserId: string; fromUserId: string; conversationId: string; callId: string }) {
    return this.notify(
      { userId: input.toUserId },
      {
        title: 'Incoming call',
        body: `Call from ${input.fromUserId}`,
        data: { conversationId: input.conversationId, callId: input.callId },
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
    const title =
      (input.senderName && String(input.senderName).trim()) ||
      'New message';
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
        },
      },
    );
  }
}
