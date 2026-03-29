// src/chat/integrations/django/django-seq.client.ts

import { Injectable } from '@nestjs/common';
import axios from 'axios';

function ensureTrailingSlash(u: string) {
  return u.endsWith('/') ? u : u + '/';
}

@Injectable()
export class DjangoSeqClient {
  async allocateSeq(conversationId: string): Promise<number> {
    const rawUrl = process.env.DJANGO_ALLOCATE_SEQ_URL!;
    const url = ensureTrailingSlash(rawUrl).replace('{conversationId}', conversationId);
    const internal = process.env.DJANGO_INTERNAL_TOKEN!;

    const { data } = await axios.post(
      url,
      {},
      { headers: { 'X-Internal-Auth': internal, Accept: 'application/json' }, timeout: 4000 },
    );

    const seq = Number(data?.seq ?? data?.value ?? data);
    if (!Number.isFinite(seq) || seq <= 0) throw new Error('Invalid seq from Django');
    return seq;
  }

  // ✅ compat alias used by realtime/handlers/messages.ts
  async allocate(conversationId: string): Promise<number> {
    return this.allocateSeq(conversationId);
  }
}
