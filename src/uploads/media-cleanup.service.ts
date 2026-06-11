// src/uploads/media-cleanup.service.ts
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message, MessageDocument } from '../chat/features/messages/schemas/message.schema';
import { StorageService } from '../storage/storage.service';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class MediaCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MediaCleanupService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    private readonly storage: StorageService,
  ) {}

  onApplicationBootstrap() {
    // Run once on startup then every hour.
    this.runCleanup().catch((e) => this.logger.error('Initial cleanup failed', e?.message));
    this.timer = setInterval(() => {
      this.runCleanup().catch((e) => this.logger.error('Scheduled cleanup failed', e?.message));
    }, CLEANUP_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async runCleanup(): Promise<void> {
    const now = new Date();

    // Find all messages with at least one non-expired attachment whose expiresAt has passed.
    const messages = await this.messageModel
      .find({
        'attachments': {
          $elemMatch: {
            expiresAt: { $lt: now },
            expired: { $ne: true },
          },
        },
      })
      .lean()
      .exec();

    if (!messages.length) return;

    this.logger.log(`[MediaCleanup] Processing ${messages.length} message(s) with expired attachments`);

    let deleted = 0;
    let errors = 0;

    for (const msg of messages) {
      const attachments: any[] = Array.isArray((msg as any).attachments) ? (msg as any).attachments : [];
      let changed = false;

      for (const att of attachments) {
        if (att.expired || !att.expiresAt) continue;
        const expiry = new Date(att.expiresAt);
        if (expiry > now) continue;

        // Delete the file from storage using the id (which is the S3 key).
        const key = att.id;
        if (key) {
          try {
            await this.storage.deleteFile(key);
            deleted++;
          } catch (e: any) {
            // NoSuchKey is fine — file already gone.
            if (e?.name !== 'NoSuchKey' && !String(e?.message ?? '').includes('NoSuchKey')) {
              this.logger.warn(`[MediaCleanup] Failed to delete key=${key}: ${e?.message}`);
              errors++;
              continue;
            }
          }
        }
        att.expired = true;
        att.url = '';
        changed = true;
      }

      if (changed) {
        await this.messageModel.updateOne(
          { _id: (msg as any)._id },
          { $set: { attachments } },
        ).exec();
      }
    }

    this.logger.log(`[MediaCleanup] Done — deleted=${deleted} errors=${errors}`);
  }
}
