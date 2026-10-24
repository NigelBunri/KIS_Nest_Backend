// src/uploads/upload-validation.ts
// Shared between the legacy multipart proxy (`POST /uploads/file`) and the
// signed-URL handshake (`POST /uploads/initiate` + `/confirm`) so both paths
// enforce identical file-type/size rules.

export const DEFAULT_MAX_UPLOAD_BYTES = 2_147_483_647;
export const MAX_UPLOAD_BYTES =
  Number(process.env.UPLOAD_MAX_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;

// Mirrors the broadcast feed's own existing public-read S3 prefixes
// (videos/*, broadcast_videos/*, broadcast_thumbnails/*) for feed/community
// post attachments, which previously had no public prefix at all - every
// upload shared the same unprefixed, bucket-policy-invisible key space as
// private 1:1/group chat media, so the only way to serve a feed image/video
// inline was a short-lived presigned GET (works, but re-signs on every
// view and can't be cached by a CDN).
export const PUBLIC_UPLOAD_PREFIX = 'community_feed/';
// CONFIRMED ROOT CAUSE of live-stream "wait screen" images/videos going
// dead: LiveControlRoom.tsx uploads this asset under context
// 'broadcast_live_wait_media' and saves the returned URL permanently on
// the ChannelLiveStream row (thumbnail_url) - but that context wasn't in
// this allowlist, so it silently fell onto the *private*, unprefixed key
// space and got back a presigned GET capped at DISPLAY_URL_TTL_SECONDS
// (7 days) with no re-signing path yet. A stream scheduled more than a
// week out, or simply viewed by an anonymous/non-owner viewer after that
// window, saw a dead URL - this isn't short-lived content like a DM
// attachment, it has to stay valid for as long as the stream stays
// scheduled/live. Same reasoning as 'feed' above, now extended here.
const PUBLIC_UPLOAD_CONTEXTS = new Set(['feed', 'broadcast_live_wait_media']);
export const isPublicUploadContext = (context?: string | null): boolean =>
  PUBLIC_UPLOAD_CONTEXTS.has(String(context || '').trim().toLowerCase());

export const BLOCKED_EXTENSIONS = new Set([
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

export const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/'];
export const ALLOWED_MIME_TYPES = new Set([
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

export const extensionFor = (filename?: string) => {
  const match = String(filename || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
};

export const isAllowedMime = (mime?: string) => {
  const normalized = String(mime || '').toLowerCase();
  if (!normalized || normalized === 'application/octet-stream') return false;
  return (
    ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    ALLOWED_MIME_TYPES.has(normalized)
  );
};

export const servesUploadsPublicly = () => {
  const explicit = String(process.env.SERVE_UPLOADS_PUBLICLY ?? '').trim();
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return (process.env.NODE_ENV ?? '').toLowerCase() !== 'production';
};

export const uploadScanStatus = () =>
  String(process.env.UPLOAD_SCAN_REQUIRED ?? '').trim() === '1'
    ? 'pending'
    : 'not_configured';

export const guessAttachmentKind = (mimeType: string | null | undefined) => {
  if (!mimeType) return 'other';
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('text/') || normalized.startsWith('application/')) return 'document';
  return 'other';
};

export const SHORT_VIDEO_MAX_BYTES =
  Number(process.env.SHORT_VIDEO_MAX_BYTES) || 15 * 1024 * 1024; // ~15MB
export const SHORT_VIDEO_DURATION_SECONDS =
  Number(process.env.SHORT_VIDEO_DURATION_SECONDS) || 3 * 60;

export const classifyKind = (
  baseKind: string,
  size: number,
  durationSeconds: number | undefined,
): string => {
  if (baseKind !== 'video') return baseKind;
  if (durationSeconds !== undefined) {
    return durationSeconds < SHORT_VIDEO_DURATION_SECONDS ? 'short_video' : 'video';
  }
  return size <= SHORT_VIDEO_MAX_BYTES ? 'short_video' : 'video';
};

export const videoCategoryForKind = (kind: string): string | undefined => {
  if (kind === 'short_video') return 'shorts';
  if (kind === 'video' || kind === 'long_video') return 'videos';
  return undefined;
};

export const ATTACHMENT_TTL_DAYS = Number(process.env.ATTACHMENT_TTL_DAYS || '10');

// AWS SigV4's own hard cap on any presigned URL's lifetime, regardless of
// requested value - this is the longest an inline-preview display URL
// (see upload-intent.service.ts/uploads.controller.ts's displayUrl) can
// possibly stay valid. A post viewed after this window needs a freshly
// re-resolved URL (not yet built), so this is strictly better than no
// inline preview at all, not a complete fix for arbitrarily-old content.
export const DISPLAY_URL_TTL_SECONDS = Math.min(
  Number(process.env.DISPLAY_URL_TTL_SECONDS) || 604800,
  604800,
);
