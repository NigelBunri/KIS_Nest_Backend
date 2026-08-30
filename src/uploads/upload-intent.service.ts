// src/uploads/upload-intent.service.ts
//
// Direct-to-S3 presigned-PUT upload handshake for chat (and every other
// caller of the shared frontend `uploadFileToBackend` helper). Mirrors
// apps/media/upload_intent.py on the Django backend:
//   1. initiate — validate declared filename/content_type/size, create an
//      UploadIntent pinned to the caller, return a short-lived presigned
//      PUT URL.
//   2. (client PUTs bytes directly to storage — this service isn't involved)
//   3. confirm  — verify what actually landed via headObjectMeta, mark the
//      intent confirmed, return the same attachment JSON shape the legacy
//      `/uploads/file` proxy endpoint already returns.
//
// Trade-off vs. the legacy proxy endpoint: bytes never pass through Nest,
// so the magic-byte/executable sniffing `uploads.controller.ts` does on the
// buffered upload isn't possible here. Content-type is instead pinned by
// the presigned URL's own signature (S3 rejects a PUT whose Content-Type
// header doesn't match what was signed) and re-checked against the
// allowlist at confirm time — the same posture Django's profile-image
// upload already accepts.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { StorageService } from '../storage/storage.service';
import { DjangoMediaClient } from '../chat/integrations/django/django-media.client';
import { UploadIntent, UploadIntentDocument } from './schemas/upload-intent.schema';
import {
  ATTACHMENT_TTL_DAYS,
  BLOCKED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  classifyKind,
  extensionFor,
  guessAttachmentKind,
  isAllowedMime,
  servesUploadsPublicly,
  uploadScanStatus,
  videoCategoryForKind,
} from './upload-validation';

const PRESIGN_EXPIRY_SECONDS = Number(process.env.UPLOAD_PRESIGN_EXPIRY_SECONDS) || 600;
const INTENT_EXPIRY_SECONDS =
  Number(process.env.UPLOAD_INTENT_EXPIRY_SECONDS) || PRESIGN_EXPIRY_SECONDS + 300;

export type InitiateUploadParams = {
  userId: string;
  context?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  conversationId?: string;
  clientId?: string;
};

export type ConfirmUploadParams = {
  userId: string;
  uploadId: string;
  durationSeconds?: number;
  host?: string;
  proto?: string;
  // broadcast_video context only — see confirm()'s post-confirm branch.
  title?: string;
  description?: string;
  channelId?: string;
  thumbnailAttachmentId?: string;
};

@Injectable()
export class UploadIntentService {
  constructor(
    @InjectModel(UploadIntent.name) private readonly intentModel: Model<UploadIntentDocument>,
    private readonly storage: StorageService,
    private readonly djangoMedia: DjangoMediaClient,
  ) {}

  async initiate(params: InitiateUploadParams) {
    const filename = String(params.filename || '').trim();
    const contentType = String(params.contentType || '').trim().toLowerCase();
    const sizeBytes = Number(params.sizeBytes);

    if (!filename) throw new BadRequestException('A filename is required.');
    const ext = extensionFor(filename);
    if (ext && BLOCKED_EXTENSIONS.has(ext)) {
      throw new BadRequestException('This file type is not allowed.');
    }
    if (!isAllowedMime(contentType)) {
      throw new BadRequestException('This content type is not allowed.');
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new BadRequestException('size_bytes must be a positive integer.');
    }
    if (sizeBytes > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`File exceeds the maximum allowed size of ${MAX_UPLOAD_BYTES} bytes.`);
    }

    const safeName = filename.replace(/[^\w.\-]+/g, '_');
    const objectKey = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}`;
    // Deliberately a *different* random UUID than any part of objectKey —
    // this is the only value the client is allowed to send back to
    // /uploads/:id/confirm. It never contains '/', unlike objectKey.
    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + INTENT_EXPIRY_SECONDS * 1000);

    await this.intentModel.create({
      ownerId: params.userId,
      context: params.context || 'general',
      uploadId,
      objectKey,
      contentType,
      originalFilename: safeName,
      sizeBytes,
      status: 'pending',
      expiresAt,
      conversationId: params.conversationId,
      clientId: params.clientId,
    });

    const uploadUrl = await this.storage.generatePresignedPut(objectKey, contentType, PRESIGN_EXPIRY_SECONDS);

    return {
      // Canonical, camelCase field the client must use for confirmation.
      uploadId,
      storageKey: objectKey,
      uploadUrl,
      headers: { 'Content-Type': contentType },
      expiresInSeconds: PRESIGN_EXPIRY_SECONDS,
      // Legacy snake_case aliases kept only for backward compatibility with
      // any in-flight client build during rollout — never derived from the
      // storage key. Safe to remove once all clients are confirmed on the
      // camelCase contract above.
      upload_id: uploadId,
      upload_url: uploadUrl,
      object_key: objectKey,
      expires_in: PRESIGN_EXPIRY_SECONDS,
      required_headers: { 'Content-Type': contentType },
    };
  }

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async confirm(params: ConfirmUploadParams) {
    // Reject anything that isn't shaped like the UUID minted at initiate
    // time up front — in particular, a raw storage key (which always
    // contains '/') gets a controlled 400 here instead of either a bare
    // Mongo miss or, worse, silently matching the wrong record.
    if (!params.uploadId || !UploadIntentService.UUID_RE.test(params.uploadId)) {
      throw new BadRequestException(
        'Invalid upload confirmation id — expected the uploadId returned by /uploads/initiate, not a storage key.',
      );
    }

    const intent = await this.intentModel.findOne({
      uploadId: params.uploadId,
      ownerId: params.userId,
    });
    if (!intent) {
      // Same response whether the id doesn't exist or belongs to someone
      // else — never reveal which.
      throw new NotFoundException('Upload not found.');
    }

    if (intent.status === 'confirmed') {
      return intent.confirmedAttachment;
    }
    if (intent.status === 'failed' || intent.status === 'expired' || intent.status === 'aborted') {
      throw new BadRequestException(`This upload cannot be confirmed (status=${intent.status}).`);
    }
    if (intent.expiresAt.getTime() < Date.now()) {
      intent.status = 'expired';
      await intent.save();
      throw new BadRequestException('This upload has expired. Please start a new upload.');
    }

    const meta = await this.storage.headObjectMeta(intent.objectKey);
    if (!meta) {
      intent.status = 'failed';
      intent.failureReason = 'object_missing';
      await intent.save();
      throw new BadRequestException('Upload not found in storage. Please retry the upload.');
    }

    if (meta.size <= 0) {
      intent.status = 'failed';
      intent.failureReason = 'empty_object';
      await intent.save();
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (meta.size > MAX_UPLOAD_BYTES) {
      intent.status = 'failed';
      intent.failureReason = 'object_too_large';
      await intent.save();
      throw new BadRequestException('Uploaded file is larger than the permitted size.');
    }
    // Allow slack between declared and actual size (compression/multipart
    // chunking can shift this by a few bytes) but reject anything wildly
    // different from what was declared at initiate time.
    const ratio = meta.size / intent.sizeBytes;
    if (intent.sizeBytes > 0 && !(ratio >= 0.5 && ratio <= 2.0)) {
      intent.status = 'failed';
      intent.failureReason = 'size_mismatch';
      await intent.save();
      throw new BadRequestException('Uploaded file size does not match what was declared.');
    }
    const actualContentType = (meta.contentType || intent.contentType).toLowerCase();
    if (!isAllowedMime(actualContentType)) {
      intent.status = 'failed';
      intent.failureReason = 'content_type_mismatch';
      await intent.save();
      throw new BadRequestException("Uploaded file's content type is not allowed.");
    }

    // First confirm mints the stable, opaque id this attachment will be
    // known by everywhere downstream (message persistence, socket
    // broadcast, history, the receiver's download-url request). Repeat
    // confirms (client retry after a dropped response) must return the
    // SAME id — never mint a second one for the same intent.
    if (!intent.attachmentId) {
      intent.attachmentId = randomUUID();
    }

    const attachment = this.buildAttachment(intent, meta, params);

    // broadcast_video context: the byte transfer just happened direct-to-S3
    // (never touching Django), but the video still needs Django's
    // duration-probe/BroadcastVideo-row/thumbnail work — see
    // apps/broadcasts/views_internal.py's ProcessBroadcastVideoUploadView,
    // which does inline (now, via this webhook) what BroadcastVideoUploadView
    // used to do inside the original multipart-proxy request. Runs
    // synchronously and can fail hard: a confirmed attachment with no
    // BroadcastVideo row behind it is an orphaned, unusable state (nothing
    // for a feed post to reference), so this isn't a best-effort add-on.
    let finalAttachment: Record<string, unknown> = attachment;
    if (intent.context === 'broadcast_video' && (attachment.kind === 'video' || attachment.kind === 'short_video')) {
      let thumbnailObjectKey: string | undefined;
      if (params.thumbnailAttachmentId) {
        const thumbIntent = await this.intentModel
          .findOne({ attachmentId: params.thumbnailAttachmentId, status: 'confirmed' })
          .lean()
          .exec();
        thumbnailObjectKey = thumbIntent?.objectKey;
      }
      const processed = await this.djangoMedia.processVideoUpload({
        objectKey: intent.objectKey,
        mimeType: actualContentType,
        originalFilename: intent.originalFilename,
        sizeBytes: meta.size,
        title: params.title,
        description: params.description,
        channelId: params.channelId,
        userId: params.userId,
        thumbnailObjectKey,
      });
      finalAttachment = { ...attachment, id: processed.video_id, ...processed };
    }

    // Every confirmed direct-to-S3 upload gets scanned for explicit content,
    // regardless of context — this is the general-purpose screening pass,
    // separate from broadcast_video's synchronous processing above (which
    // handles duration/thumbnail/BroadcastVideo-row work, not content
    // safety). Fire-and-forget: never adds latency here, and a flagged
    // upload gets taken down asynchronously via Django calling back to
    // POST /internal/attachments/quarantine once the scan completes.
    try {
      this.djangoMedia.notifyUploadForScan({
        objectKey: intent.objectKey,
        mimeType: actualContentType,
        originalFilename: intent.originalFilename,
        sizeBytes: meta.size,
        context: intent.context,
        userId: params.userId,
      });
    } catch {
      // Truly fire-and-forget — even a synchronous throw here must never
      // break the confirm response.
    }

    intent.status = 'confirmed';
    intent.confirmedAttachment = finalAttachment;
    await intent.save();

    return finalAttachment;
  }

  private buildAttachment(
    intent: UploadIntentDocument,
    meta: { size: number; contentType: string },
    params: ConfirmUploadParams,
  ): Record<string, unknown> {
    const actualContentType = (meta.contentType || intent.contentType).toLowerCase();
    const baseKind = guessAttachmentKind(actualContentType);
    const durationSeconds = params.durationSeconds;
    const kind = classifyKind(baseKind, meta.size, durationSeconds);
    const videoCategory = videoCategoryForKind(kind);

    const host = params.host;
    const proto = params.proto || 'http';
    // Legacy, unauthenticated key-based link — kept only for the
    // transitional compatibility window (see uploads.controller.ts). New
    // downloads should call GET /uploads/:attachmentId/download-url instead.
    const authenticatedDownloadUrl = host
      ? `${proto}://${host}/uploads/file?key=${encodeURIComponent(intent.objectKey)}`
      : `/uploads/file?key=${encodeURIComponent(intent.objectKey)}`;

    const publicStorage = this.storage.isPublic();
    const publicUploadsEnabled = servesUploadsPublicly();
    const primaryUrl = publicStorage ? this.storage.publicUrlFor(intent.objectKey) : authenticatedDownloadUrl;

    const expiresAt = new Date(Date.now() + ATTACHMENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const scanStatus = uploadScanStatus();

    const attachment: Record<string, unknown> = {
      id: intent.attachmentId,
      storageKey: intent.objectKey,
      url: primaryUrl,
      publicUrl: publicStorage ? primaryUrl : undefined,
      displayUrl: primaryUrl,
      downloadUrl: authenticatedDownloadUrl,
      name: intent.originalFilename,
      mime: actualContentType,
      originalName: intent.originalFilename,
      mimeType: actualContentType,
      size: meta.size,
      kind,
      expiresAt,
      expired: false,
      visibility: publicStorage || publicUploadsEnabled ? 'public' : 'private',
      private: !publicStorage && !publicUploadsEnabled,
      scanStatus,
      quarantined: scanStatus === 'pending',
    };
    if (durationSeconds !== undefined) {
      attachment.duration_seconds = Math.round(durationSeconds);
    }
    if (videoCategory) {
      attachment.video_category = videoCategory;
    }
    return attachment;
  }

  /**
   * Registers a synchronously-completed upload (the legacy `POST
   * /uploads/file` multipart proxy, which never goes through
   * initiate/confirm) as an already-confirmed UploadIntent, so it is
   * resolvable through the exact same attachmentId lookup path as
   * presigned-PUT uploads. Keeps a single canonical resolution mechanism
   * for AttachmentAccessService instead of two.
   */
  async recordDirectUpload(params: {
    ownerId: string;
    objectKey: string;
    contentType: string;
    originalFilename: string;
    sizeBytes: number;
    conversationId?: string;
    attachment: Record<string, unknown>;
  }): Promise<string> {
    const attachmentId = randomUUID();
    const expiresAt = new Date(Date.now() + ATTACHMENT_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.intentModel.create({
      ownerId: params.ownerId,
      context: 'legacy_multipart',
      // This path bytes-uploads synchronously and is already 'confirmed'
      // by the time this record is created — there is no separate confirm
      // step to guard, but uploadId is a required schema field, so mint one
      // for consistency (distinct from attachmentId, which is client-facing).
      uploadId: randomUUID(),
      objectKey: params.objectKey,
      attachmentId,
      contentType: params.contentType,
      originalFilename: params.originalFilename,
      sizeBytes: params.sizeBytes,
      status: 'confirmed',
      expiresAt,
      conversationId: params.conversationId,
      confirmedAttachment: { ...params.attachment, id: attachmentId, storageKey: params.objectKey },
    });
    return attachmentId;
  }
}
