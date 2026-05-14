import crypto from 'crypto';

export const INTERNAL_AUTH_HEADER = 'X-Internal-Auth';
export const INTERNAL_TIMESTAMP_HEADER = 'X-Internal-Timestamp';
export const INTERNAL_NONCE_HEADER = 'X-Internal-Nonce';
export const INTERNAL_SIGNATURE_HEADER = 'X-Internal-Signature';

const nonceCache = new Map<string, number>();

function maxSkewSeconds() {
  const raw = Number(process.env.INTERNAL_SIGNATURE_MAX_SKEW_SECONDS ?? 300);
  return Number.isFinite(raw) ? Math.max(30, Math.floor(raw)) : 300;
}

export function internalSignaturesRequired() {
  const configured = String(
    process.env.INTERNAL_SIGNATURE_REQUIRED ?? '',
  ).trim();
  if (configured)
    return ['1', 'true', 'yes', 'on'].includes(configured.toLowerCase());
  return String(process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

function stableStringify(value: unknown, parseJsonString = false): string {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value)) return stableStringify(value.toString('utf8'), true);
  if (typeof value === 'string') {
    if (parseJsonString) {
      try {
        return stableStringify(JSON.parse(value));
      } catch {
        return value;
      }
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function bodyHash(body: unknown) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(body, typeof body === 'string'))
    .digest('hex');
}

function pathWithQuery(urlOrPath: string, params?: Record<string, unknown>) {
  const parsed = new URL(urlOrPath, 'http://internal.local');
  if (params) {
    for (const key of Object.keys(params).sort()) {
      const value = params[key];
      if (value === undefined || value === null) continue;
      parsed.searchParams.set(key, String(value));
    }
  }
  const query = parsed.searchParams.toString();
  return `${parsed.pathname || '/'}${query ? `?${query}` : ''}`;
}

function signaturePayload(args: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}) {
  return [
    args.method.toUpperCase(),
    args.path || '/',
    args.timestamp,
    args.nonce,
    args.bodyHash,
  ].join('\n');
}

function sign(secret: string, payload: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function signedInternalHeaders(args: {
  method: string;
  url: string;
  body?: unknown;
  params?: Record<string, unknown>;
  secret?: string;
}): Record<string, string> {
  const secret = String(
    args.secret ?? process.env.DJANGO_INTERNAL_TOKEN ?? '',
  ).trim();
  if (!secret) return {};
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const payload = signaturePayload({
    method: args.method,
    path: pathWithQuery(args.url, args.params),
    timestamp,
    nonce,
    bodyHash: bodyHash(args.body),
  });
  return {
    [INTERNAL_AUTH_HEADER]: secret,
    [INTERNAL_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_NONCE_HEADER]: nonce,
    [INTERNAL_SIGNATURE_HEADER]: sign(secret, payload),
  };
}

export function verifyInternalSignature(args: {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
}) {
  const timestamp = firstHeader(args.headers['x-internal-timestamp']);
  const nonce = firstHeader(args.headers['x-internal-nonce']);
  const signature = firstHeader(args.headers['x-internal-signature']);
  if (!timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing_signature_headers' };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const skew = maxSkewSeconds();
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > skew) {
    return { ok: false, reason: 'timestamp_outside_window' };
  }
  const now = Date.now();
  for (const [key, expiresAt] of nonceCache.entries()) {
    if (expiresAt <= now) nonceCache.delete(key);
  }
  if (nonceCache.has(nonce)) {
    return { ok: false, reason: 'replayed_nonce' };
  }

  const payload = signaturePayload({
    method: args.method,
    path: pathWithQuery(args.url),
    timestamp,
    nonce,
    bodyHash: bodyHash(args.body),
  });
  const expected = sign(args.secret, payload);
  const valid =
    expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!valid) return { ok: false, reason: 'signature_mismatch' };
  nonceCache.set(nonce, now + skew * 1000);
  return { ok: true, reason: 'ok' };
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
