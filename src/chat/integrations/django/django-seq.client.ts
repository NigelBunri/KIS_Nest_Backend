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

function allocateSeqUrl(conversationId: string): string {
  const explicit = String(process.env.DJANGO_ALLOCATE_SEQ_URL ?? '').trim();
  if (explicit) {
    return ensureTrailingSlash(explicit).replace('{conversationId}', conversationId);
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

    const { data } = await axios.post(
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
        timeout: 4000,
      },
    );

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
