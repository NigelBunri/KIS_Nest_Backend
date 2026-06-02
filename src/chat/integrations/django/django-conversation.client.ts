// src/chat/integrations/django/django-conversation.client.ts

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  SocketPrincipal,
  ConversationPermission,
  isBroadcastConversation,
} from '../../chat.types';
import { signedInternalHeaders } from '../../../security/internal-signing';

export interface DjangoWsPermsResponse {
  isMember: boolean;
  isBlocked: boolean;
  role?: string;
  canSend?: boolean;
  scopes?: ConversationPermission[];
}

export interface DjangoMemberIdsResponse {
  user_ids?: string[];
  userIds?: string[];
}

export interface DjangoPolicyCheckResponse {
  allowed: boolean;
  reason?: string;
  matches?: string[];
  warn?: string[];
}

function applyConversationIdTemplate(url: string | undefined, conversationId: string) {
  if (!url) return undefined;
  const encoded = encodeURIComponent(conversationId);
  return url
    .replace(/\{conversationId\}/g, encoded)
    .replace(/\{conversation_id\}/g, encoded);
}

@Injectable()
export class DjangoConversationClient {
  constructor(private readonly http: HttpService) {}
  private readonly permsCache = new Map<
    string,
    { expiresAt: number; staleUntil: number; data: DjangoWsPermsResponse }
  >();
  private readonly permsTtlMs = Number(
    process.env.DJANGO_CONV_PERMS_TTL_MS ?? 120_000,
  );
  // How long stale entries are kept as a fallback when Django is unreachable
  private readonly permsStaleTtlMs = this.permsTtlMs * 10;

  private readonly memberIdsCache = new Map<
    string,
    { expiresAt: number; ids: string[] }
  >();
  private readonly memberIdsTtlMs = 30_000;

  /**
   * Fetch conversation-scoped permissions from Django
   *
   * Django endpoint:
   *   GET /api/v1/chat/conversations/{conversationId}/ws-perms/
   *
   * Headers:
   *   Authorization: Bearer <JWT>
   *   X-Internal-Auth: <DJANGO_INTERNAL_TOKEN>
   */
  async wsPerms(
    principal: SocketPrincipal,
    conversationId: string,
  ): Promise<DjangoWsPermsResponse> {
    const tokenHash = principal.token ? principal.token.slice(-8) : 'anon';
    const cacheKey = `${principal.userId}:${conversationId}:${tokenHash}`;
    const now = Date.now();
    const cached = this.permsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    if (isBroadcastConversation(conversationId)) {
      const perms = this.buildBroadcastPerms();
      this.permsCache.set(cacheKey, {
        expiresAt: now + this.permsTtlMs,
        staleUntil: now + this.permsStaleTtlMs,
        data: perms,
      });
      return perms;
    }
    const base = this.djangoApiBase();
    const url =
      applyConversationIdTemplate(process.env.DJANGO_CONV_PERMS_URL, conversationId) ??
      (base
        ? `${base}/chat/conversations/${conversationId}/ws-perms/`
        : undefined);

    if (!url) {
      throw new Error('DJANGO_CONV_PERMS_URL is not configured');
    }

    const headers: Record<string, string> = {
      ...signedInternalHeaders({
        method: 'GET',
        url,
        params: { userId: principal.userId },
        secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
      }),
    };
    if (principal.token) {
      headers.Authorization = `Bearer ${principal.token}`;
    }

    try {
      const res = await firstValueFrom(
        this.http.get<DjangoWsPermsResponse>(url, {
          headers,
          params: { userId: principal.userId },
          timeout: 5000,
        }),
      );

      const data = res.data;
      this.permsCache.set(cacheKey, {
        expiresAt: now + this.permsTtlMs,
        staleUntil: now + this.permsStaleTtlMs,
        data,
      });
      return data;
    } catch (err: any) {
      // Serve stale cache first — covers most cold-start windows
      if (cached && cached.staleUntil > now) {
        return cached.data;
      }
      // Explicit 4xx from Django (bad token, forbidden) — hard block
      const httpStatus: number | undefined = err?.response?.status;
      if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
        throw new UnauthorizedException('Conversation permission check failed');
      }
      // Network error / timeout / 5xx — Django is unreachable, allow through
      // rather than killing every call during a cold start.
      const fallback: DjangoWsPermsResponse = { isMember: true, isBlocked: false, canSend: true };
      this.permsCache.set(cacheKey, {
        expiresAt: now + 30_000,
        staleUntil: now + this.permsStaleTtlMs,
        data: fallback,
      });
      return fallback;
    }
  }

  /**
   * Convenience guard:
   * - must be member
   * - must not be blocked
   */
  async assertMember(
    principal: SocketPrincipal,
    conversationId: string,
  ): Promise<DjangoWsPermsResponse> {
    if (isBroadcastConversation(conversationId)) {
      return this.buildBroadcastPerms();
    }
    const perms = await this.wsPerms(principal, conversationId);

    if (!perms.isMember) {
      throw new UnauthorizedException('Not a conversation member');
    }

    if (perms.isBlocked) {
      throw new UnauthorizedException('Conversation is blocked');
    }

    return perms;
  }

  async updateLastMessage(args: {
    conversationId: string;
    createdAt: Date;
    preview?: string;
  }) {
    const base = this.djangoApiBase();
    const url =
      applyConversationIdTemplate(process.env.DJANGO_CONV_UPDATE_LAST_MESSAGE_URL, args.conversationId) ??
      (base
        ? `${base}/chat/conversations/${args.conversationId}/update-last-message/`
        : undefined);

    if (!url) return;

    await firstValueFrom(
      this.http.patch(
        url,
        {
          last_message_at: args.createdAt.toISOString(),
          last_message_preview: (args.preview ?? '').slice(0, 255),
        },
        {
          headers: {
            ...signedInternalHeaders({
              method: 'PATCH',
              url,
              body: {
                last_message_at: args.createdAt.toISOString(),
                last_message_preview: (args.preview ?? '').slice(0, 255),
              },
              secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
            }),
          },
        },
      ),
    );
  }

  async updateReadState(args: {
    conversationId: string;
    userId: string;
    lastReadSeq: number;
    lastReadAt?: string | Date | null;
  }) {
    const base = this.djangoApiBase();
    const url =
      applyConversationIdTemplate(process.env.DJANGO_CONV_UPDATE_READ_STATE_URL, args.conversationId) ??
      (base
        ? `${base}/chat/conversations/${args.conversationId}/update-read-state/`
        : undefined);

    if (!url) return;

    await firstValueFrom(
      this.http.patch(
        url,
        {
          user_id: args.userId,
          last_read_seq: args.lastReadSeq,
          last_read_at:
            args.lastReadAt instanceof Date
              ? args.lastReadAt.toISOString()
              : (args.lastReadAt ?? undefined),
        },
        {
          headers: {
            ...signedInternalHeaders({
              method: 'PATCH',
              url,
              body: {
                user_id: args.userId,
                last_read_seq: args.lastReadSeq,
                last_read_at:
                  args.lastReadAt instanceof Date
                    ? args.lastReadAt.toISOString()
                    : (args.lastReadAt ?? undefined),
              },
              secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
            }),
          },
        },
      ),
    );
  }

  async listMemberIds(conversationId: string): Promise<string[]> {
    if (isBroadcastConversation(conversationId)) {
      return [];
    }

    const now = Date.now();
    const cached = this.memberIdsCache.get(conversationId);
    if (cached && cached.expiresAt > now) {
      return cached.ids;
    }

    const base = this.djangoApiBase();
    const url =
      applyConversationIdTemplate(process.env.DJANGO_CONV_MEMBER_IDS_URL, conversationId) ??
      (base
        ? `${base}/chat/conversations/${conversationId}/member-ids/`
        : undefined);

    if (!url) return [];

    try {
      const res = await firstValueFrom(
        this.http.get<DjangoMemberIdsResponse>(url, {
          headers: {
            ...signedInternalHeaders({
              method: 'GET',
              url,
              secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
            }),
          },
          timeout: 5000,
        }),
      );

      const data = res?.data ?? {};
      const ids = (data.user_ids ?? data.userIds ?? []).map((id) => String(id));
      this.memberIdsCache.set(conversationId, { expiresAt: now + this.memberIdsTtlMs, ids });
      return ids;
    } catch {
      // Serve stale cache if Django is unreachable so CONVERSATION_UPDATED still broadcasts
      if (cached) return cached.ids;
      return [];
    }
  }

  async policyCheck(args: {
    principal: SocketPrincipal;
    conversationId: string;
    action: 'send' | 'edit' | 'delete';
    text?: string;
  }): Promise<DjangoPolicyCheckResponse> {
    if (isBroadcastConversation(args.conversationId)) {
      return { allowed: true };
    }
    const base = this.djangoApiBase();
    const url =
      applyConversationIdTemplate(process.env.DJANGO_CONV_POLICY_CHECK_URL, args.conversationId) ??
      (base
        ? `${base}/chat/conversations/${args.conversationId}/policy-check/`
        : undefined);

    if (!url) return { allowed: true };

    const headers: Record<string, string> = {
      ...signedInternalHeaders({
        method: 'POST',
        url,
        body: {
          action: args.action,
          userId: args.principal.userId,
          text: args.text ?? '',
        },
        secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
      }),
    };
    if (args.principal.token) {
      headers.Authorization = `Bearer ${args.principal.token}`;
    }

    const res = await firstValueFrom(
      this.http.post<DjangoPolicyCheckResponse>(
        url,
        {
          action: args.action,
          userId: args.principal.userId,
          text: args.text ?? '',
        },
        { headers },
      ),
    );
    return res?.data ?? { allowed: true };
  }

  async dispatchWebhook(args: {
    conversationId: string;
    event: string;
    payload?: Record<string, any>;
  }): Promise<{ delivered: number }> {
    const base = this.djangoApiBase();
    const url =
      process.env.DJANGO_CONV_WEBHOOK_DISPATCH_URL ??
      (base
        ? `${base}/chat/conversations/${args.conversationId}/webhook-dispatch/`
        : undefined);

    if (!url) return { delivered: 0 };

    const res = await firstValueFrom(
      this.http.post<{ delivered: number }>(
        url,
        { event: args.event, payload: args.payload ?? {} },
        {
          headers: {
            ...signedInternalHeaders({
              method: 'POST',
              url,
              body: { event: args.event, payload: args.payload ?? {} },
              secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
            }),
          },
        },
      ),
    );
    return res?.data ?? { delivered: 0 };
  }

  private buildBroadcastPerms(): DjangoWsPermsResponse {
    return { isMember: true, isBlocked: false, canSend: true };
  }

  private djangoApiBase(): string | undefined {
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
}
