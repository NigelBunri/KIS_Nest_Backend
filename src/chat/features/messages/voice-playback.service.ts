// src/chat/features/messages/voice-playback.service.ts
//
// Single authorization + resolution chokepoint for refreshing a voice-note
// playback URL. Mirrors uploads/attachment-access.service.ts's shape and
// trust model exactly (same DjangoConversationClient.assertMember call), but
// resolves against `message.voice` instead of `message.attachments[]`,
// since voice notes are uploaded through Django's legacy multipart endpoint
// (see KIS RN uploadFileToBackend.ts's isNestChatBackend check), not Nest's
// own upload-intent/attachment tracking.

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Message, MessageDocument } from './schemas/message.schema';
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client';
import { DjangoMediaClient } from '../../integrations/django/django-media.client';

export type VoicePlaybackPrincipal = { userId: string; token?: string; [key: string]: unknown };

export type ResolvedVoicePlayback = {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
};

@Injectable()
export class VoicePlaybackService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    private readonly djangoConversationClient: DjangoConversationClient,
    private readonly djangoMediaClient: DjangoMediaClient,
  ) {}

  async resolvePlaybackUrl(
    messageId: string,
    principal: VoicePlaybackPrincipal,
  ): Promise<ResolvedVoicePlayback> {
    if (!messageId || typeof messageId !== 'string') {
      throw new NotFoundException('Voice message not found.');
    }

    // A malformed _id (not a valid ObjectId) throws a Mongoose CastError
    // synchronously rather than just not matching — only include that
    // branch when the id shape is actually valid, so an arbitrary/garbage
    // messageId cleanly 404s instead of 500ing.
    const orConditions: Record<string, unknown>[] = [{ clientId: messageId }];
    if (Types.ObjectId.isValid(messageId)) {
      orConditions.push({ _id: messageId });
    }

    const message = await this.messageModel
      .findOne({ $or: orConditions })
      .lean()
      .exec();

    if (!message || (message as any).isDeleted || (message as any).kind !== 'voice' || !(message as any).voice) {
      throw new NotFoundException('Voice message not found.');
    }

    await this.assertAccess(principal, (message as any).conversationId);

    const voice = (message as any).voice as {
      mediaAssetId?: string;
      objectKey?: string;
    };

    // Historical rows persisted before VoiceMeta declared mediaAssetId (or
    // before it existed at all — the original Mongoose-stripping bug) may
    // have nothing the server can re-sign. Never fabricate access — a
    // typed 404 lets the client show a clear "unavailable" state instead of
    // a misleading generic playback error.
    const mediaAssetId = voice.mediaAssetId || voice.objectKey;
    if (!mediaAssetId) {
      throw new NotFoundException('This voice message cannot be refreshed.');
    }

    return this.djangoMediaClient.signChatVoiceAsset({
      mediaAssetId,
      objectKey: voice.objectKey,
    });
  }

  private async assertAccess(principal: VoicePlaybackPrincipal, conversationId: string): Promise<void> {
    try {
      await this.djangoConversationClient.assertMember(principal as any, conversationId);
    } catch {
      throw new ForbiddenException('You do not have access to this voice message.');
    }
  }
}
