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

export type ProcessedBroadcastVideo = {
  video_id: string;
  video_url: string;
  stream_url: string;
  thumbnail_url: string;
  duration_seconds: number;
  type: string;
  mime_type: string;
  scan_status: string;
  quarantined: boolean;
  requires_review: boolean;
  safety_scan_id: string;
  safety: Record<string, unknown>;
  processing_status: string;
  pipeline: Record<string, unknown>;
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

  /**
   * Asks Django to run its video-processing pipeline (duration probe,
   * short/long classification, BroadcastVideo row creation, thumbnail
   * generation) against a video that already landed in S3 via Nest's
   * direct-to-S3 flow — see UploadIntentService.confirm(), the only caller.
   * Mirrors apps/broadcasts/views_internal.py's ProcessBroadcastVideoUploadView
   * on the Django side, which does inline (not queued) what
   * BroadcastVideoUploadView used to do inside the original upload request.
   */
  async processVideoUpload(args: {
    objectKey: string;
    mimeType: string;
    originalFilename: string;
    sizeBytes: number;
    title?: string;
    description?: string;
    channelId?: string;
    userId?: string;
    thumbnailObjectKey?: string;
  }): Promise<ProcessedBroadcastVideo> {
    const base = this.djangoApiBase();
    const url = base
      ? `${base}/broadcasts/internal/process-video-upload/`
      : String(process.env.DJANGO_PROCESS_VIDEO_UPLOAD_URL ?? '').trim();
    if (!url) {
      throw new BadGatewayException('Video processing is not configured.');
    }

    const body: Record<string, unknown> = {
      objectKey: args.objectKey,
      mimeType: args.mimeType,
      originalFilename: args.originalFilename,
      sizeBytes: args.sizeBytes,
    };
    if (args.title) body.title = args.title;
    if (args.description) body.description = args.description;
    if (args.channelId) body.channelId = args.channelId;
    if (args.userId) body.userId = args.userId;
    if (args.thumbnailObjectKey) body.thumbnailObjectKey = args.thumbnailObjectKey;

    const headers = signedInternalHeaders({
      method: 'POST',
      url,
      body,
      secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
    });

    try {
      const res = await firstValueFrom(
        this.http.post<ProcessedBroadcastVideo>(url, body, { headers, timeout: 60000 }),
      );
      if (!res?.data?.video_id) {
        throw new BadGatewayException('Video processing returned no video id.');
      }
      return res.data;
    } catch (err: any) {
      if (err instanceof BadGatewayException) throw err;
      const httpStatus: number | undefined = err?.response?.status;
      if (httpStatus === 404) {
        throw new NotFoundException('Uploaded video was not found in storage.');
      }
      throw new BadGatewayException('Could not reach the video processing service. Please try again.');
    }
  }
}
