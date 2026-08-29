// src/chat/features/messages/voice-playback.service.ts
//
// Single authorization + resolution chokepoint for refreshing a voice-note
// playback URL. Mirrors uploads/attachment-access.service.ts's shape and
// trust model exactly (same DjangoConversationClient.assertMember call), but
// resolves against `message.voice` instead of `message.attachments[]`.
//
// Voice notes now upload through Nest's own direct-to-S3 signed-URL flow
// (uploadFileToBackend.ts no longer special-cases voice/stickers onto
// Django's legacy multipart proxy — see ChatRoomHandlers.tsx's
// handleSendVoice/handleSendSticker, both now pass baseUrl: NEST_API_BASE_URL).
// For those, `voice.mediaAssetId` is a Nest UploadIntent.attachmentId, and
// this service presigns the GET itself via StorageService — no Django round
// trip at all. Historical voice notes sent before this change still have
// `voice.mediaAssetId` pointing at a Django MediaAsset id with no matching
// UploadIntent row; djangoMediaClient.signChatVoiceAsset is kept ONLY as the
// fallback for those older rows so they don't go permanently unplayable
// once their original signed URL expires.

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Message, MessageDocument } from './schemas/message.schema';
import { UploadIntent, UploadIntentDocument } from '../../../uploads/schemas/upload-intent.schema';
import { StorageService } from '../../../storage/storage.service';
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client';
import { DjangoMediaClient } from '../../integrations/django/django-media.client';

export type VoicePlaybackPrincipal = { userId: string; token?: string; [key: string]: unknown };

export type ResolvedVoicePlayback = {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
};

// Independent from AttachmentAccessService's DOWNLOAD_URL_TTL_SECONDS (300s)
// — voice notes can run long and a listener scrubbing through one shouldn't
// risk the URL expiring mid-playback the way a one-shot file download can
// tolerate. Matches Django's now-legacy-only CHAT_VOICE_PLAYBACK_TTL_SECONDS
// default so the refresh cadence doesn't change for existing conversations.
const CHAT_VOICE_PLAYBACK_TTL_SECONDS = Number(process.env.CHAT_VOICE_PLAYBACK_TTL_SECONDS) || 900;

@Injectable()
export class VoicePlaybackService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(UploadIntent.name) private readonly uploadIntentModel: Model<UploadIntentDocument>,
    private readonly storage: StorageService,
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

    // Deliberately NOT gated on message.kind === 'voice'. An E2EE-sent
    // voice note's server-visible kind is always 'text' by design (see KIS
    // RN useChatMessaging.ts - "the real kind lives inside the encrypted
    // payload, keep the server-visible shell generic"), with only a
    // plaintext voice{mediaAssetId, objectKey, durationMs} echo surviving
    // outside the envelope specifically so this endpoint can still resolve
    // it. Requiring kind === 'voice' on top of that made every E2EE voice
    // note's playback URL permanently unrefreshable the moment its signed
    // URL TTL expired (CHAT_VOICE_PLAYBACK_TTL_SECONDS, 15 min) - i.e.
    // nearly every voice note in nearly every conversation, since E2EE is
    // on by default. The presence of message.voice is itself the
    // authoritative signal; kind isn't a trustworthy one here.
    if (!message || (message as any).isDeleted || !(message as any).voice) {
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

    const direct = await this.resolveViaNestStorage(mediaAssetId);
    if (direct) return direct;

    // Legacy fallback — mediaAssetId doesn't match any UploadIntent this
    // service minted, so it's a pre-migration Django MediaAsset id. Only
    // Django knows that file's real bucket key.
    return this.djangoMediaClient.signChatVoiceAsset({
      mediaAssetId,
      objectKey: voice.objectKey,
    });
  }

  /**
   * Returns a freshly presigned GET for a voice note uploaded through
   * Nest's own direct-to-S3 flow, or null if mediaAssetId isn't a Nest
   * UploadIntent.attachmentId at all (legacy Django-originated row) or the
   * deployment isn't S3-backed (local-disk dev has no presigned-GET
   * concept — see StorageService.generatePresignedGet's own doc comment).
   */
  private async resolveViaNestStorage(attachmentId: string): Promise<ResolvedVoicePlayback | null> {
    if (this.storage.driver() !== 's3') return null;

    const intent = await this.uploadIntentModel
      .findOne({ attachmentId, status: 'confirmed' })
      .lean()
      .exec();
    if (!intent?.objectKey) return null;

    const url = await this.storage.generatePresignedGet(
      intent.objectKey,
      CHAT_VOICE_PLAYBACK_TTL_SECONDS,
      intent.originalFilename,
    );
    const expiresAt = new Date(Date.now() + CHAT_VOICE_PLAYBACK_TTL_SECONDS * 1000).toISOString();
    return { url, expiresAt, expiresInSeconds: CHAT_VOICE_PLAYBACK_TTL_SECONDS };
  }

  private async assertAccess(principal: VoicePlaybackPrincipal, conversationId: string): Promise<void> {
    try {
      await this.djangoConversationClient.assertMember(principal as any, conversationId);
    } catch {
      throw new ForbiddenException('You do not have access to this voice message.');
    }
  }
}
