// src/uploads/uploads.controller.ts
import { Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';   // ✅ type-only import fixes TS1272
import '@fastify/multipart';                     // ✅ bring in .file() augmentation (types-side effect)
import { LocalStorageService } from '../storage/local-storage.service';

const SHORT_VIDEO_MAX_BYTES =
  Number(process.env.SHORT_VIDEO_MAX_BYTES) || 15 * 1024 * 1024; // ~15MB
const SHORT_VIDEO_DURATION_SECONDS = Number(process.env.SHORT_VIDEO_DURATION_SECONDS) || 3 * 60;

@Controller('uploads')
export class UploadsController {
  constructor(private readonly local: LocalStorageService) {}

  @Post('file')
  async upload(@Req() req: FastifyRequest) {
    // Parse a single file via @fastify/multipart
    // (FastifyRequest doesn't know .file() unless you wire generics; simplest is cast)
    const mp: any = await (req as any).file();
    if (!mp) return { error: 'No file provided' };

    // Collect buffer
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      mp.file.on('data', (c: Buffer) => chunks.push(c));
      mp.file.on('end', () => resolve());
      mp.file.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);

    const parseDurationSeconds = () => {
      const query = (req.query ?? {}) as Record<string, string | string[] | undefined>;
      const toString = (value: string | string[] | undefined) =>
        Array.isArray(value) ? value[0] : value;
      const secondsValue = toString(query.duration_seconds ?? query.durationSeconds);
      if (secondsValue) {
        const numeric = Number(secondsValue);
        if (Number.isFinite(numeric)) {
          return numeric;
        }
      }
      const millisValue = toString(query.duration_ms ?? query.durationMs);
      if (millisValue) {
        const numeric = Number(millisValue);
        if (Number.isFinite(numeric)) {
          return numeric / 1000;
        }
      }
      return undefined;
    };

    const size = buffer.length;
    if (size > 50 * 1024 * 1024) {
      return { error: 'File too large' };
    }

    const host = req.headers?.host;
    const proto =
      (req.headers?.['x-forwarded-proto'] as string) ||
      (req as any).protocol ||
      'http';
    const publicBase = host ? `${proto}://${host}/uploads` : undefined;

    const stored = await this.local.storeLocal({
      buffer,
      filename: mp.filename,
      mime: mp.mimetype || 'application/octet-stream',
      size,
      publicBase,
    });

    const baseKind = (() => {
      const mime = stored.mime || '';
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime.includes('pdf') || mime.includes('msword') || mime.includes('officedocument'))
        return 'document';
      return 'other';
    })();
    const durationSeconds = parseDurationSeconds();
    let kind = baseKind;
    if (baseKind === 'video') {
      if (durationSeconds !== undefined) {
        kind =
          durationSeconds < SHORT_VIDEO_DURATION_SECONDS ? 'short_video' : 'video';
      } else if (size <= SHORT_VIDEO_MAX_BYTES) {
        kind = 'short_video';
      } else {
        kind = 'video';
      }
    }

    const videoCategory =
      kind === 'short_video'
        ? 'shorts'
        : kind === 'video' || kind === 'long_video'
        ? 'videos'
        : undefined;

    const attachmentResponse: Record<string, unknown> = {
      id: stored.key,
      url: stored.url,
      name: stored.name,
      mime: stored.mime,
      originalName: stored.name,
      mimeType: stored.mime,
      size: stored.size,
      kind,
    };
    if (durationSeconds !== undefined) {
      attachmentResponse.duration_seconds = Math.round(durationSeconds);
    }
    if (videoCategory) {
      attachmentResponse.video_category = videoCategory;
    }

    return {
      ok: true,
      attachment: attachmentResponse,
    };
  }
}
