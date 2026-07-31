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
};

@Injectable()
export class UploadIntentService {
  constructor(
    @InjectModel(UploadIntent.name) private readonly intentModel: Model<UploadIntentDocument>,
    private readonly storage: StorageService,
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
    const expiresAt = new Date(Date.now() + INTENT_EXPIRY_SECONDS * 1000);

    await this.intentModel.create({
      ownerId: params.userId,
      context: params.context || 'general',
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
      upload_id: objectKey,
      upload_url: uploadUrl,
      object_key: objectKey,
      expires_in: PRESIGN_EXPIRY_SECONDS,
      required_headers: { 'Content-Type': contentType },
    };
  }

  async confirm(params: ConfirmUploadParams) {
    // The object key doubles as upload_id — it's already unguessable
    // (random UUID) and pinning confirm to "the intent owned by this user
    // whose key is this" avoids a second, separate identifier.
    const intent = await this.intentModel.findOne({
      objectKey: params.uploadId,
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

    const attachment = this.buildAttachment(intent, meta, params);

    intent.status = 'confirmed';
    intent.confirmedAttachment = attachment;
    await intent.save();

    return attachment;
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
    const authenticatedDownloadUrl = host
      ? `${proto}://${host}/uploads/file?key=${encodeURIComponent(intent.objectKey)}`
      : `/uploads/file?key=${encodeURIComponent(intent.objectKey)}`;

    const publicStorage = this.storage.isPublic();
    const publicUploadsEnabled = servesUploadsPublicly();
    const primaryUrl = publicStorage ? this.storage.publicUrlFor(intent.objectKey) : authenticatedDownloadUrl;

    const expiresAt = new Date(Date.now() + ATTACHMENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const scanStatus = uploadScanStatus();

    const attachment: Record<string, unknown> = {
      id: intent.objectKey,
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
}
