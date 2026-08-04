// src/chat/integrations/django/django-media.client.ts
//
// Nest -> Django trusted-internal call for refreshing a voice-note playback
// URL. Only ever called AFTER VoicePlaybackService has already authenticated
// the requesting user and verified conversation membership — Django's
// internal endpoint deliberately does not re-derive that (see
// apps/media/views_internal.py's ChatVoicePlaybackSignView docstring on the
// Django side for the full trust-boundary rationale).

import { BadGatewayException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { signedInternalHeaders } from '../../../security/internal-signing';

export type SignedChatVoiceUrl = {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
};

@Injectable()
export class DjangoMediaClient {
  constructor(private readonly http: HttpService) {}

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

  /**
   * Asks Django to sign a short-lived playback URL for a voice attachment,
   * identified by Django's own MediaAsset id (never a client-supplied raw
   * storage key — see VoicePlaybackService, which derives mediaAssetId from
   * the persisted message, not from the request).
   */
  async signChatVoiceAsset(args: { mediaAssetId: string; objectKey?: string }): Promise<SignedChatVoiceUrl> {
    const base = this.djangoApiBase();
    const url = base
      ? `${base}/media/internal/chat-voice/sign/`
      : String(process.env.DJANGO_CHAT_VOICE_SIGN_URL ?? '').trim();
    if (!url) {
      throw new BadGatewayException('Voice media signing is not configured.');
    }

    const body: Record<string, string> = { mediaAssetId: args.mediaAssetId };
    if (args.objectKey) body.objectKey = args.objectKey;

    const headers = signedInternalHeaders({
      method: 'POST',
      url,
      body,
      secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
    });

    try {
      const res = await firstValueFrom(
        this.http.post<SignedChatVoiceUrl>(url, body, { headers, timeout: 8000 }),
      );
      if (!res?.data?.url) {
        throw new BadGatewayException('Voice media signing returned no URL.');
      }
      return res.data;
    } catch (err: any) {
      const httpStatus: number | undefined = err?.response?.status;
      if (httpStatus === 404) {
        throw new NotFoundException('This voice message is no longer available.');
      }
      if (httpStatus === 403) {
        throw new ForbiddenException('This media is not available for playback.');
      }
      if (err instanceof BadGatewayException) throw err;
      // Network error / timeout / 5xx from Django — surface as a distinct,
      // typed upstream failure rather than a generic 500, so the RN client
      // can show "try again" instead of a silent/opaque failure.
      throw new BadGatewayException('Could not reach the media signing service. Please try again.');
    }
  }
}
