// src/chat/integrations/django/django-seq.client.ts

import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { signedInternalHeaders } from '../../../security/internal-signing';

function ensureTrailingSlash(u: string) {
  return u.endsWith('/') ? u : u + '/';
}

function djangoApiBase(): string | undefined {
  const configured = String(process.env.DJANGO_API_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const introspectUrl = String(process.env.DJANGO_INTROSPECT_URL ?? '').trim();
  if (!introspectUrl) return undefined;

  try {
    const parsed = new URL(introspectUrl);
    const marker = '/api/v1/';
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex >= 0) {
      parsed.pathname = parsed.pathname.slice(0, markerIndex + marker.length - 1);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/+$/, '');
    }
    parsed.pathname = '/api/v1';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function seqTimeoutMs() {
  const raw = Number(process.env.DJANGO_ALLOCATE_SEQ_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(raw) ? Math.max(4_000, Math.floor(raw)) : 15_000;
}

function seqRetryCount() {
  const raw = Number(process.env.DJANGO_ALLOCATE_SEQ_RETRIES ?? 2);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 2;
}

function retryDelayMs(attempt: number) {
  return Math.min(1_500, 250 * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableSeqError(error: any) {
  const status = Number(error?.response?.status);
  return !status || status >= 500;
}

function allocateSeqUrl(conversationId: string): string {
  const explicit = String(process.env.DJANGO_ALLOCATE_SEQ_URL ?? '').trim();
  if (explicit) {
    const encoded = encodeURIComponent(conversationId);
    return ensureTrailingSlash(explicit)
      .replace(/\{conversationId\}/g, encoded)
      .replace(/\{conversation_id\}/g, encoded);
  }

  const base = djangoApiBase();
  if (!base) {
    throw new Error(
      'Django sequence allocator is not configured. Set DJANGO_ALLOCATE_SEQ_URL, DJANGO_API_URL, or DJANGO_INTROSPECT_URL.',
    );
  }
  return `${base}/chat/conversations/${conversationId}/allocate-seq/`;
}

@Injectable()
export class DjangoSeqClient {
  async allocateSeq(conversationId: string): Promise<number> {
    const url = allocateSeqUrl(conversationId);
    const internal = process.env.DJANGO_INTERNAL_TOKEN ?? '';
    if (!internal) {
      throw new Error('DJANGO_INTERNAL_TOKEN is not configured');
    }

    let data: any;
    let lastError: any;
    const attempts = seqRetryCount() + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await axios.post(
          url,
          {},
          {
            headers: {
              ...signedInternalHeaders({
                method: 'POST',
                url,
                body: {},
                secret: internal,
              }),
              Accept: 'application/json',
            },
            timeout: seqTimeoutMs(),
          },
        );
        data = response.data;
        lastError = undefined;
        break;
      } catch (error: any) {
        lastError = error;
        if (attempt >= attempts - 1 || !isRetryableSeqError(error)) {
          throw error;
        }
        await sleep(retryDelayMs(attempt));
      }
    }

    if (lastError) throw lastError;

    const seq = Number(data?.seq ?? data?.value ?? data);
    if (!Number.isFinite(seq) || seq <= 0) {
      throw new Error('Invalid seq from Django');
    }
    return seq;
  }

  async allocate(conversationId: string): Promise<number> {
    return this.allocateSeq(conversationId);
  }
}
