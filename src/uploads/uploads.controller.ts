// src/uploads/uploads.controller.ts
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify'; // ✅ type-only import fixes TS1272
import '@fastify/multipart'; // ✅ bring in .file() augmentation (types-side effect)
import { StorageService } from '../storage/storage.service';
import { HttpAuthGuard } from '../auth/http-auth.guard';

const SHORT_VIDEO_MAX_BYTES =
  Number(process.env.SHORT_VIDEO_MAX_BYTES) || 15 * 1024 * 1024; // ~15MB
const SHORT_VIDEO_DURATION_SECONDS =
  Number(process.env.SHORT_VIDEO_DURATION_SECONDS) || 3 * 60;
const DEFAULT_MAX_UPLOAD_BYTES = 2_147_483_647;
const MAX_UPLOAD_BYTES =
  Number(process.env.UPLOAD_MAX_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;
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
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
]);

// Magic-byte signatures: [bytes, offset, allowed_mime_prefixes_or_types]
const MAGIC_SIGNATURES: Array<{ bytes: number[]; offset?: number; mimes: string[] }> = [
  { bytes: [0xff, 0xd8, 0xff], mimes: ['image/jpeg'] },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mimes: ['image/png'] },
  { bytes: [0x47, 0x49, 0x46, 0x38], mimes: ['image/gif'] },
  { bytes: [0x52, 0x49, 0x46, 0x46], mimes: ['image/webp', 'audio/wav'] },
  { bytes: [0x25, 0x50, 0x44, 0x46], mimes: ['application/pdf'] },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mimes: ['application/zip', 'application/vnd.openxmlformats', 'application/vnd.ms-'] },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], mimes: ['video/webm'] },
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, mimes: ['video/mp4', 'video/quicktime', 'video/'] },
  { bytes: [0x4f, 0x67, 0x67, 0x53], mimes: ['audio/ogg', 'video/ogg'] },
  { bytes: [0x49, 0x44, 0x33], mimes: ['audio/mpeg', 'audio/mp3'] },
  { bytes: [0xff, 0xfb], mimes: ['audio/mpeg', 'audio/mp3'] },
  { bytes: [0xff, 0xf3], mimes: ['audio/mpeg', 'audio/mp3'] },
  // Block executables regardless of declared type
];
const BLOCKED_MAGIC: number[][] = [
  [0x4d, 0x5a],             // MZ — Windows PE executable
  [0x7f, 0x45, 0x4c, 0x46], // ELF — Linux/Unix binary
];

function detectMagicMime(buf: Buffer): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    const off = sig.offset ?? 0
    const slice = buf.slice(off, off + sig.bytes.length)
    if (sig.bytes.every((b, i) => slice[i] === b)) return sig.mimes[0]
  }
  return null
}

function hasBlockedMagic(buf: Buffer): boolean {
  return BLOCKED_MAGIC.some(sig => sig.every((b, i) => buf[i] === b))
}

const extensionFor = (filename?: string) => {
  const match = String(filename || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
};

const isAllowedMime = (mime?: string) => {
  const normalized = String(mime || '').toLowerCase();
  if (!normalized || normalized === 'application/octet-stream') return false;
  return (
    ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    ALLOWED_MIME_TYPES.has(normalized)
  );
};

const mimeMatchesMagic = (declaredMime: string, buf: Buffer): boolean => {
  if (hasBlockedMagic(buf)) return false
  const detected = detectMagicMime(buf)
  if (!detected) return true  // unknown magic — allow, rely on extension+declared
  const norm = declaredMime.toLowerCase()
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.bytes.every((b, i) => (buf.slice(sig.offset ?? 0))[i] === b)) {
      return sig.mimes.some(m => norm.startsWith(m) || m.startsWith(norm.split('/')[0]))
    }
  }
  return true
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
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  // No auth required on download — keys contain random UUIDs so they are
  // not guessable, and removing auth eliminates the Django introspect
  // round-trip that was causing image-load timeouts on Render.com free tier.
  @Get('file')
  async download(@Query('key') key: string, @Res() reply: FastifyReply) {
    if (!key) {
      throw new BadRequestException('A file key is required.');
    }
    const file = await this.storage.getFile(key);
    const publicStorage = this.storage.isPublic();
    reply.header('cache-control', publicStorage ? 'public, max-age=31536000, immutable' : 'private, max-age=0, no-store');
    reply.type(file.mime || 'application/octet-stream');
    if (file.size !== undefined) {
      reply.header('content-length', String(file.size));
    }
    return reply.send(file.body);
  }

  @Post('file')
  @UseGuards(HttpAuthGuard)
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

    // Magic-byte validation: block executables and mismatched MIME declarations
    if (hasBlockedMagic(buffer)) {
      throw new BadRequestException('Executable file content is not allowed.');
    }
    if (!mimeMatchesMagic(mp.mimetype, buffer)) {
      throw new BadRequestException('File content does not match declared MIME type.');
    }

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
      throw new BadRequestException(`File too large. Current limit is ${MAX_UPLOAD_BYTES} bytes.`);
    }

    const host = req.headers?.host;
    const proto =
      (req.headers?.['x-forwarded-proto'] as string) ||
      (req as any).protocol ||
      'http';
    const publicUploadsEnabled = servesUploadsPublicly();
    const publicBase =
      publicUploadsEnabled && host ? `${proto}://${host}/uploads` : undefined;

    const stored = await this.storage.storeLocal({
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

    // Public S3 buckets can be displayed directly from S3/CDN. Private S3
    // buckets must use the authenticated download endpoint so objects remain
    // protected while still being streamed from S3 by the storage service.
    // For local-filesystem storage, always use the key-based download endpoint
    // for both display and download: @fastify/static does not decode %2F in
    // URL paths (security policy), so a static path like
    // /uploads/2026-06-09%2Fuuid.jpg returns 404. The ?key= query-param
    // endpoint is always safe because query params are decoded before lookup.
    const publicStorage = this.storage.isPublic();
    const primaryUrl = publicStorage ? stored.url : authenticatedDownloadUrl;
    const primaryPublicUrl = publicStorage ? stored.url : undefined;

    // Files expire from S3 after 10 days. The cleanup job uses this field.
    const FILE_TTL_DAYS = Number(process.env.ATTACHMENT_TTL_DAYS || '10');
    const expiresAt = new Date(Date.now() + FILE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const attachmentResponse: Record<string, unknown> = {
      id: stored.key,
      url: primaryUrl,
      publicUrl: primaryPublicUrl,
      displayUrl: primaryUrl,
      downloadUrl: authenticatedDownloadUrl,
      name: stored.name,
      mime: stored.mime,
      originalName: stored.name,
      mimeType: stored.mime,
      size: stored.size,
      kind,
      expiresAt,
      expired: false,
      visibility: (publicStorage || publicUploadsEnabled) ? 'public' : 'private',
      private: !publicStorage && !publicUploadsEnabled,
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
