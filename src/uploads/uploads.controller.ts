// src/uploads/uploads.controller.ts
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify'; // ✅ type-only import fixes TS1272
import '@fastify/multipart'; // ✅ bring in .file() augmentation (types-side effect)
import { createReadStream, existsSync } from 'fs';
import { LocalStorageService } from '../storage/local-storage.service';
import { HttpAuthGuard } from '../auth/http-auth.guard';

const SHORT_VIDEO_MAX_BYTES =
  Number(process.env.SHORT_VIDEO_MAX_BYTES) || 15 * 1024 * 1024; // ~15MB
const SHORT_VIDEO_DURATION_SECONDS =
  Number(process.env.SHORT_VIDEO_DURATION_SECONDS) || 3 * 60;
const MAX_UPLOAD_BYTES =
  Number(process.env.UPLOAD_MAX_BYTES) || 50 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set([
  'apk',
  'app',
  'bat',
  'bin',
  'cmd',
  'com',
  'dll',
  'dmg',
  'exe',
  'js',
  'mjs',
  'msi',
  'ps1',
  'scr',
  'sh',
  'vbs',
]);
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/'];
const ALLOWED_MIME_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
]);

const extensionFor = (filename?: string) => {
  const match = String(filename || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
};

const isAllowedMime = (mime?: string) => {
  const normalized = String(mime || '').toLowerCase();
  if (!normalized) return false;
  return (
    ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    ALLOWED_MIME_TYPES.has(normalized)
  );
};

const servesUploadsPublicly = () => {
  const explicit = String(process.env.SERVE_UPLOADS_PUBLICLY ?? '').trim();
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return (process.env.NODE_ENV ?? '').toLowerCase() !== 'production';
};

const uploadScanStatus = () =>
  String(process.env.UPLOAD_SCAN_REQUIRED ?? '').trim() === '1'
    ? 'pending'
    : 'not_configured';

@Controller('uploads')
@UseGuards(HttpAuthGuard)
export class UploadsController {
  constructor(private readonly local: LocalStorageService) {}

  @Get('file')
  async download(@Query('key') key: string, @Res() reply: FastifyReply) {
    if (!key) {
      throw new BadRequestException('A file key is required.');
    }
    let absolutePath: string;
    try {
      absolutePath = this.local.pathForKey(key);
    } catch {
      throw new BadRequestException('Invalid file key.');
    }
    if (!existsSync(absolutePath)) {
      throw new NotFoundException('File not found.');
    }
    reply.header('cache-control', 'private, max-age=0, no-store');
    reply.type('application/octet-stream');
    return reply.send(createReadStream(absolutePath));
  }

  @Post('file')
  async upload(@Req() req: FastifyRequest) {
    // Parse a single file via @fastify/multipart
    // (FastifyRequest doesn't know .file() unless you wire generics; simplest is cast)
    const mp: any = await (req as any).file();
    if (!mp) return { error: 'No file provided' };

    const ext = extensionFor(mp.filename);
    if (ext && BLOCKED_EXTENSIONS.has(ext)) {
      throw new BadRequestException('This file type is not allowed.');
    }
    if (!isAllowedMime(mp.mimetype)) {
      throw new BadRequestException('This MIME type is not allowed.');
    }

    // Collect buffer
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      mp.file.on('data', (c: Buffer) => chunks.push(c));
      mp.file.on('end', () => resolve());
      mp.file.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);

    const parseDurationSeconds = () => {
      const query = (req.query ?? {}) as Record<
        string,
        string | string[] | undefined
      >;
      const toString = (value: string | string[] | undefined) =>
        Array.isArray(value) ? value[0] : value;
      const secondsValue = toString(
        query.duration_seconds ?? query.durationSeconds,
      );
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
    if (size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File too large.');
    }

    const host = req.headers?.host;
    const proto =
      (req.headers?.['x-forwarded-proto'] as string) ||
      (req as any).protocol ||
      'http';
    const publicUploadsEnabled = servesUploadsPublicly();
    const publicBase =
      publicUploadsEnabled && host ? `${proto}://${host}/uploads` : undefined;

    const stored = await this.local.storeLocal({
      buffer,
      filename: mp.filename,
      mime: mp.mimetype || 'application/octet-stream',
      size,
      publicBase,
    });
    const authenticatedDownloadUrl = host
      ? `${proto}://${host}/uploads/file?key=${encodeURIComponent(stored.key)}`
      : `/uploads/file?key=${encodeURIComponent(stored.key)}`;

    const baseKind = (() => {
      const mime = stored.mime || '';
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      if (
        mime.includes('pdf') ||
        mime.includes('msword') ||
        mime.includes('officedocument')
      )
        return 'document';
      return 'other';
    })();
    const durationSeconds = parseDurationSeconds();
    let kind = baseKind;
    if (baseKind === 'video') {
      if (durationSeconds !== undefined) {
        kind =
          durationSeconds < SHORT_VIDEO_DURATION_SECONDS
            ? 'short_video'
            : 'video';
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
      url: publicUploadsEnabled ? stored.url : authenticatedDownloadUrl,
      publicUrl: publicUploadsEnabled ? stored.url : undefined,
      downloadUrl: authenticatedDownloadUrl,
      name: stored.name,
      mime: stored.mime,
      originalName: stored.name,
      mimeType: stored.mime,
      size: stored.size,
      kind,
      visibility: publicUploadsEnabled ? 'public' : 'private',
      private: !publicUploadsEnabled,
      scanStatus: uploadScanStatus(),
      quarantined: uploadScanStatus() === 'pending',
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
