// src/uploads/attachment-access.service.ts
//
// Single authorization + resolution chokepoint for every attachment
// download path (the presigned-GET endpoint, the local-storage stream
// endpoint, and the legacy key-based endpoint kept for compatibility).
// Nothing outside this service should decide whether a request may read an
// attachment's bytes — see uploads.controller.ts for the thin route
// wrappers that call it.

import { ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message, MessageDocument } from '../chat/features/messages/schemas/message.schema';
import { DjangoConversationClient } from '../chat/integrations/django/django-conversation.client';
import { StorageService } from '../storage/storage.service';

const DOWNLOAD_URL_TTL_SECONDS = Number(process.env.DOWNLOAD_URL_TTL_SECONDS) || 300;

export type DownloadPrincipal = { userId: string; token?: string; [key: string]: unknown };

export type ResolvedDownload = {
  attachmentId: string;
  downloadUrl: string;
  expiresInSeconds: number;
  originalName: string;
  mimeType: string;
  size: number;
};

export type ResolvedStream = {
  storageKey: string;
  originalName: string;
  mimeType: string;
};

type RawAttachment = {
  id?: string;
  storageKey?: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  expiresAt?: string | Date;
  expired?: boolean;
  viewOnce?: boolean;
  viewedAt?: string;
  scanStatus?: string;
  quarantined?: boolean;
};

const QUARANTINE_STATUSES = new Set(['pending_review', 'blocked', 'failed', 'pending']);

@Injectable()
export class AttachmentAccessService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    private readonly storage: StorageService,
    private readonly djangoConversationClient: DjangoConversationClient,
  ) {}

  private async findMessageAndAttachment(attachmentId: string): Promise<{
    message: any;
    attachment: RawAttachment;
  }> {
    if (!attachmentId || typeof attachmentId !== 'string') {
      throw new NotFoundException('Attachment not found.');
    }

    const message = await this.messageModel
      .findOne({
        $or: [{ 'attachments.id': attachmentId }, { 'media.attachments.id': attachmentId }],
      })
      .lean()
      .exec();

    if (!message || message.isDeleted) {
      throw new NotFoundException('Attachment not found.');
    }

    const attachment: RawAttachment | undefined =
      (Array.isArray(message.attachments) ? message.attachments : []).find((a: RawAttachment) => a.id === attachmentId) ??
      (Array.isArray((message as any).media?.attachments) ? (message as any).media.attachments : []).find(
        (a: RawAttachment) => a.id === attachmentId,
      );

    if (!attachment) {
      throw new NotFoundException('Attachment not found.');
    }

    return { message, attachment };
  }

  private async assertAccess(principal: DownloadPrincipal, conversationId: string): Promise<void> {
    try {
      await this.djangoConversationClient.assertMember(principal as any, conversationId);
    } catch {
      // assertMember throws UnauthorizedException for "not a member" — that
      // is a membership/authorization failure here, not an authentication
      // one (the caller is already authenticated by HttpAuthGuard), so it
      // maps to 403, matching the REST contract callers expect.
      throw new ForbiddenException('You do not have access to this attachment.');
    }
  }

  private assertNotExpiredOrConsumed(attachment: RawAttachment): void {
    if (attachment.viewOnce && attachment.viewedAt) {
      throw new GoneException('This view-once media has already been viewed.');
    }
    if (attachment.expired) {
      throw new GoneException('This attachment has expired.');
    }
    if (attachment.expiresAt && new Date(attachment.expiresAt).getTime() < Date.now()) {
      throw new GoneException('This attachment has expired.');
    }
  }

  private assertNotQuarantined(attachment: RawAttachment): void {
    const status = String(attachment.scanStatus ?? '').trim().toLowerCase();
    if (attachment.quarantined || QUARANTINE_STATUSES.has(status)) {
      throw new ForbiddenException('This attachment is unavailable pending review.');
    }
  }

  private storageKeyFor(attachment: RawAttachment): string {
    // New-style attachments carry a real storageKey; legacy rows (persisted
    // before this field existed) used the storage key itself as `id`, so
    // fall back to that — never accept a key from the caller.
    const key = attachment.storageKey || attachment.id;
    if (!key) throw new NotFoundException('Attachment not found.');
    return key;
  }

  async resolveForDownloadUrl(
    attachmentId: string,
    principal: DownloadPrincipal,
    origin?: string,
  ): Promise<ResolvedDownload> {
    const { message, attachment } = await this.findMessageAndAttachment(attachmentId);
    await this.assertAccess(principal, message.conversationId);
    this.assertNotExpiredOrConsumed(attachment);
    this.assertNotQuarantined(attachment);

    const storageKey = this.storageKeyFor(attachment);
    const meta = await this.storage.headObjectMeta(storageKey);
    if (!meta) {
      throw new NotFoundException('File is no longer available in storage.');
    }

    const originalName = attachment.originalName || 'file';
    const mimeType = attachment.mimeType || meta.contentType || 'application/octet-stream';
    const size = typeof attachment.size === 'number' ? attachment.size : meta.size;

    const downloadUrl =
      this.storage.driver() === 's3'
        ? await this.storage.generatePresignedGet(storageKey, DOWNLOAD_URL_TTL_SECONDS, originalName)
        : this.localStreamPath(attachmentId, origin);

    return {
      attachmentId,
      downloadUrl,
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      originalName,
      mimeType,
      size,
    };
  }

  async resolveForStream(attachmentId: string, principal: DownloadPrincipal): Promise<ResolvedStream> {
    const { message, attachment } = await this.findMessageAndAttachment(attachmentId);
    await this.assertAccess(principal, message.conversationId);
    this.assertNotExpiredOrConsumed(attachment);
    this.assertNotQuarantined(attachment);

    const storageKey = this.storageKeyFor(attachment);
    return {
      storageKey,
      originalName: attachment.originalName || 'file',
      mimeType: attachment.mimeType || 'application/octet-stream',
    };
  }

  /**
   * Legacy compatibility path for GET /uploads/file?key=... . Unlike the
   * id-based routes, callers here only ever have a raw storage key (old
   * clients, cached links). Resolves it back to the owning message so the
   * same membership/expiry/quarantine checks still apply — a key alone is
   * never sufficient.
   */
  async resolveForLegacyKeyDownload(key: string, principal: DownloadPrincipal): Promise<ResolvedStream> {
    if (!key) throw new NotFoundException('Attachment not found.');

    const message = await this.messageModel
      .findOne({
        $or: [
          { 'attachments.storageKey': key },
          { 'attachments.id': key },
          { 'media.attachments.storageKey': key },
          { 'media.attachments.id': key },
        ],
      })
      .lean()
      .exec();

    if (!message || message.isDeleted) {
      throw new NotFoundException('Attachment not found.');
    }

    const attachment: RawAttachment | undefined =
      (Array.isArray(message.attachments) ? message.attachments : []).find(
        (a: RawAttachment) => a.storageKey === key || a.id === key,
      ) ??
      (Array.isArray((message as any).media?.attachments) ? (message as any).media.attachments : []).find(
        (a: RawAttachment) => a.storageKey === key || a.id === key,
      );

    if (!attachment) {
      throw new NotFoundException('Attachment not found.');
    }

    await this.assertAccess(principal, message.conversationId);
    this.assertNotExpiredOrConsumed(attachment);
    this.assertNotQuarantined(attachment);

    return {
      storageKey: this.storageKeyFor(attachment),
      originalName: attachment.originalName || 'file',
      mimeType: attachment.mimeType || 'application/octet-stream',
    };
  }

  private localStreamPath(attachmentId: string, origin?: string): string {
    const path = `/uploads/${encodeURIComponent(attachmentId)}/stream`;
    return origin ? `${origin.replace(/\/$/, '')}${path}` : path;
  }

  /**
   * Trusted-internal only (see uploads.controller.ts's quarantine route) —
   * Django's async content-safety scan calls this after confirming a
   * violation, to take the content down immediately. Matches by
   * attachments[].storageKey since that's the same objectKey Django scanned
   * (see UploadIntentService.confirm(), which now notifies Django of every
   * direct-to-S3 upload, not just broadcast video). Voice notes and
   * stickers are covered too — handleSendVoice/handleSendSticker persist
   * the same object into attachments[0] as a redundant copy specifically
   * for lookups like this one.
   */
  async quarantineByStorageKey(objectKey: string): Promise<boolean> {
    if (!objectKey) return false;
    const result = await this.messageModel.updateOne(
      { 'attachments.storageKey': objectKey },
      { $set: { 'attachments.$.quarantined': true, 'attachments.$.scanStatus': 'blocked' } },
    );
    if (result.modifiedCount > 0) return true;
    // Legacy rows persisted before storageKey existed used the storage key
    // itself as `id` (see storageKeyFor's own fallback) — try that shape too.
    const legacyResult = await this.messageModel.updateOne(
      { 'attachments.id': objectKey },
      { $set: { 'attachments.$.quarantined': true, 'attachments.$.scanStatus': 'blocked' } },
    );
    return legacyResult.modifiedCount > 0;
  }
}
