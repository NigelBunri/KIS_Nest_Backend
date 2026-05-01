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

@Injectable()
export class DjangoConversationClient {
  constructor(private readonly http: HttpService) {}
  private readonly permsCache = new Map<
    string,
    { expiresAt: number; data: DjangoWsPermsResponse }
  >();
  private readonly permsTtlMs = Number(
    process.env.DJANGO_CONV_PERMS_TTL_MS ?? 8000,
  );

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
        data: perms,
      });
      return perms;
    }
    const url = process.env.DJANGO_CONV_PERMS_URL?.replace(
      '{conversationId}',
      conversationId,
    );

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
        }),
      );

      const data = res.data;
      this.permsCache.set(cacheKey, {
        expiresAt: now + this.permsTtlMs,
        data,
      });
      return data;
    } catch (err) {
      throw new UnauthorizedException('Conversation permission check failed');
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
    const base = process.env.DJANGO_API_URL;
    const url =
      process.env.DJANGO_CONV_UPDATE_LAST_MESSAGE_URL ??
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
    const base = process.env.DJANGO_API_URL;
    const url =
      process.env.DJANGO_CONV_UPDATE_READ_STATE_URL ??
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
    const base = process.env.DJANGO_API_URL;
    const url =
      process.env.DJANGO_CONV_MEMBER_IDS_URL ??
      (base
        ? `${base}/chat/conversations/${conversationId}/member-ids/`
        : undefined);

    if (!url) return [];

    const res = await firstValueFrom(
      this.http.get<DjangoMemberIdsResponse>(url, {
        headers: {
          ...signedInternalHeaders({
            method: 'GET',
            url,
            secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
          }),
        },
      }),
    );

    const data = res?.data ?? {};
    return (data.user_ids ?? data.userIds ?? []).map((id) => String(id));
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
    const base = process.env.DJANGO_API_URL;
    const url =
      process.env.DJANGO_CONV_POLICY_CHECK_URL ??
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
    const base = process.env.DJANGO_API_URL;
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
}
