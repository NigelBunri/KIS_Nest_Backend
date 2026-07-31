// src/uploads/upload-validation.ts
// Shared between the legacy multipart proxy (`POST /uploads/file`) and the
// signed-URL handshake (`POST /uploads/initiate` + `/confirm`) so both paths
// enforce identical file-type/size rules.

export const DEFAULT_MAX_UPLOAD_BYTES = 2_147_483_647;
export const MAX_UPLOAD_BYTES =
  Number(process.env.UPLOAD_MAX_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;

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
