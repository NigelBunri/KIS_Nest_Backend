// src/chat/features/messages/messages.controller.ts
import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { HttpAuthGuard } from '../../../auth/http-auth.guard';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { VoicePlaybackService } from './voice-playback.service';

@Controller('chat/messages')
export class MessagesController {
  constructor(
    private readonly voicePlayback: VoicePlaybackService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // Refreshes an expired/expiring voice-note playback URL. Never accepts an
  // object key or asset id from the client — the server derives it from the
  // persisted message (see VoicePlaybackService), and re-verifies
  // conversation membership on every call (no long-lived "you checked once"
  // assumption). Rate-limited per user: normal repeated playback (a user
  // replaying the same note, or scrolling through a history of many voice
  // notes) stays well under this; only pathological polling would hit it.
  @Get(':messageId/voice/playback-url')
  @UseGuards(HttpAuthGuard)
  async getVoicePlaybackUrl(@Req() req: FastifyRequest, @Param('messageId') messageId: string) {
    const principal = (req as any).principal;
    await this.rateLimit.assertAllowed({
      key: `voice-playback-url:${principal?.userId ?? 'anon'}`,
      limit: 60,
      windowMs: 60_000,
    });
    return this.voicePlayback.resolvePlaybackUrl(messageId, principal);
  }
}
