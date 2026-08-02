// src/uploads/media-cleanup.service.ts
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message, MessageDocument } from '../chat/features/messages/schemas/message.schema';
import { UploadIntent, UploadIntentDocument } from './schemas/upload-intent.schema';
import { StorageService } from '../storage/storage.service';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ABANDONED_INTENT_SWEEP_LIMIT = 500;

@Injectable()
export class MediaCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MediaCleanupService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(UploadIntent.name) private readonly uploadIntentModel: Model<UploadIntentDocument>,
    private readonly storage: StorageService,
  ) {}

  onApplicationBootstrap() {
    // Run once on startup then every hour.
    this.runCleanup().catch((e) => this.logger.error('Initial cleanup failed', e?.message));
    this.runAbandonedIntentCleanup().catch((e) =>
      this.logger.error('Initial abandoned-intent cleanup failed', e?.message),
    );
    this.timer = setInterval(() => {
      this.runCleanup().catch((e) => this.logger.error('Scheduled cleanup failed', e?.message));
      this.runAbandonedIntentCleanup().catch((e) =>
        this.logger.error('Scheduled abandoned-intent cleanup failed', e?.message),
      );
    }, CLEANUP_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Presigned URL issued (via /uploads/initiate) but never confirmed —
   * best-effort deletes any object that may exist at that key, then marks
   * the intent expired. Mirrors Django's expire_abandoned_upload_intents in
   * apps/media/upload_intent.py. Never touches a `confirmed` intent — those
   * own a real, attached attachment a message may still reference. */
  async runAbandonedIntentCleanup(): Promise<void> {
    const now = new Date();
    const candidates = await this.uploadIntentModel
      .find({ status: { $in: ['pending', 'uploaded'] }, expiresAt: { $lte: now } })
      .sort({ expiresAt: 1 })
      .limit(ABANDONED_INTENT_SWEEP_LIMIT)
      .exec();

    if (!candidates.length) return;

    let expired = 0;
    let cleanupFailures = 0;
    for (const intent of candidates) {
      try {
        // Idempotent on most backends even if nothing was ever actually
        // uploaded at this key — the common case for a truly abandoned intent.
        await this.storage.deleteFile(intent.objectKey);
      } catch (e: any) {
        cleanupFailures++;
        this.logger.warn(`[MediaCleanup] Failed to delete abandoned key=${intent.objectKey}: ${e?.message}`);
      }
      intent.status = 'expired';
      await intent.save();
      expired++;
    }

    this.logger.log(`[MediaCleanup] Abandoned intents — expired=${expired} cleanupFailures=${cleanupFailures}`);
  }

  async runCleanup(): Promise<void> {
    const now = new Date();

    // Find all messages with at least one non-expired attachment (in either
    // array — `attachments` and `media.attachments` are persisted as
    // duplicates of the same list) whose expiresAt has passed.
    const expiredElemMatch = { expiresAt: { $lt: now }, expired: { $ne: true } };
    const messages = await this.messageModel
      .find({
        $or: [
          { attachments: { $elemMatch: expiredElemMatch } },
          { 'media.attachments': { $elemMatch: expiredElemMatch } },
        ],
      })
      .lean()
      .exec();

    if (!messages.length) return;

    this.logger.log(`[MediaCleanup] Processing ${messages.length} message(s) with expired attachments`);

    let deleted = 0;
    let errors = 0;

    // Deletes the underlying object at most once per storage key even when
    // the same attachment appears in both `attachments` and
    // `media.attachments` on the same message.
    const expireOne = async (att: any, alreadyDeletedKeys: Set<string>): Promise<boolean> => {
      if (att.expired || !att.expiresAt) return false;
      const expiry = new Date(att.expiresAt);
      if (expiry > now) return false;

      // Prefer the real storage key; only legacy rows (persisted before
      // storageKey existed) used `id` as the key directly.
      const key: string | undefined = att.storageKey || att.id;
      if (key && !alreadyDeletedKeys.has(key)) {
        try {
          await this.storage.deleteFile(key);
          alreadyDeletedKeys.add(key);
          deleted++;
        } catch (e: any) {
          // NoSuchKey is fine — file already gone.
          if (e?.name !== 'NoSuchKey' && !String(e?.message ?? '').includes('NoSuchKey')) {
            this.logger.warn(`[MediaCleanup] Failed to delete key=${key}: ${e?.message}`);
            errors++;
            return false;
          }
          alreadyDeletedKeys.add(key);
        }
      }
      att.expired = true;
      att.url = '';
      return true;
    };

    for (const msg of messages) {
      const attachments: any[] = Array.isArray((msg as any).attachments) ? (msg as any).attachments : [];
      const mediaAttachments: any[] = Array.isArray((msg as any).media?.attachments)
        ? (msg as any).media.attachments
        : [];
      const deletedKeys = new Set<string>();
      let changed = false;

      for (const att of attachments) {
        if (await expireOne(att, deletedKeys)) changed = true;
      }
      for (const att of mediaAttachments) {
        if (await expireOne(att, deletedKeys)) changed = true;
      }

      if (changed) {
        const update: Record<string, unknown> = { attachments };
        if ((msg as any).media) {
          update.media = { ...(msg as any).media, attachments: mediaAttachments };
        }
        await this.messageModel.updateOne({ _id: (msg as any)._id }, { $set: update }).exec();
      }
    }

    this.logger.log(`[MediaCleanup] Done — deleted=${deleted} errors=${errors}`);
  }
}
