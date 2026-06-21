import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { CallsService } from './calls.service'
import { DjangoAuthService } from '../../../auth/django-auth.service'

@Controller('calls')
export class CallsController {
  constructor(
    private readonly callsService: CallsService,
    private readonly authService: DjangoAuthService,
  ) {}

  private async resolveUser(req: FastifyRequest) {
    const authHeader = req.headers.authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token')
    }
    const token = authHeader.slice('Bearer '.length)
    const principal = await this.authService.introspect(token)
    return principal
  }

  /** GET /calls/history — list call history for the authenticated user. */
  @Get('history')
  async history(
    @Req() req: FastifyRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const principal = await this.resolveUser(req)
    const parsedLimit = limit ? Number(limit) : undefined
    return this.callsService.listUserCalls({
      userId: principal.userId,
      limit: Number.isFinite(parsedLimit as number) ? parsedLimit : undefined,
      before,
    })
  }

  /**
   * GET /calls/missed-count — return the number of missed calls since a given
   * timestamp.  Used by notification badges.
   * Query param: since (ISO string, optional — defaults to 24 h ago).
   */
  @Get('missed-count')
  async missedCount(
    @Req() req: FastifyRequest,
    @Query('since') since?: string,
  ) {
    const principal = await this.resolveUser(req)
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 86_400_000)
    const count = await this.callsService.countMissedCallsSince(principal.userId, sinceDate)
    return { count }
  }

  /**
   * GET /calls/ice-servers — return TURN/STUN credentials for WebRTC.
   * Credentials are derived from server-side environment variables so they
   * are never baked into the client bundle.
   */
  @Get('ice-servers')
  async iceServers(@Req() req: FastifyRequest) {
    await this.resolveUser(req)
    return this.callsService.getTurnCredentials()
  }

  /**
   * POST /calls/standalone — create a call that is NOT tied to an existing
   * conversation.  Returns callId, conversationId, and an inviteToken that
   * recipients can use to join via a deep link.
   */
  @Post('standalone')
  async createStandalone(
    @Req() req: FastifyRequest,
    @Body()
    body: {
      call_id: string
      call_type?: string
      title?: string
      scheduled_for?: string
      invitee_user_ids?: string[]
    },
  ) {
    const principal = await this.resolveUser(req)
    if (!body.call_id) throw new NotFoundException('call_id required')

    const scheduledFor = body.scheduled_for ? new Date(body.scheduled_for) : null

    const call = await this.callsService.createStandaloneCall({
      callId: body.call_id,
      createdBy: principal.userId,
      callType: body.call_type ?? 'voice',
      title: body.title ?? 'Call',
      scheduledFor,
      inviteeUserIds: body.invitee_user_ids,
    })

    return {
      callId: call.callId,
      conversationId: call.conversationId,
      inviteToken: call.inviteToken,
      callType: call.callType,
      title: call.title,
      scheduledFor: call.scheduledFor,
      isStandalone: call.isStandalone,
    }
  }

  /**
   * GET /calls/join/:token — resolve an invite token to call info so the
   * client can join without knowing the conversationId up front.
   */
  @Get('join/:token')
  async joinByToken(@Req() req: FastifyRequest, @Param('token') token: string) {
    await this.resolveUser(req)
    const call = await this.callsService.getCallByToken(token)
    if (!call) throw new NotFoundException('Invite link not found or has expired')
    return {
      callId: call.callId,
      conversationId: call.conversationId,
      callType: call.callType,
      title: call.title,
      status: call.status,
      isStandalone: call.isStandalone,
      scheduledFor: call.scheduledFor,
      participantCount: call.participants.length,
    }
  }

  /**
   * GET /calls/scheduled — list upcoming scheduled calls for the authenticated user.
   */
  @Get('scheduled')
  async scheduled(@Req() req: FastifyRequest) {
    const principal = await this.resolveUser(req)
    const calls = await this.callsService.getScheduledCalls(principal.userId)
    return {
      calls: calls.map((c) => ({
        callId: c.callId,
        conversationId: c.conversationId,
        callType: c.callType,
        title: c.title,
        scheduledFor: c.scheduledFor,
        isStandalone: c.isStandalone,
        inviteToken: c.inviteToken,
        participantCount: c.participants.length,
      })),
    }
  }

  /**
   * POST /calls/history — fire-and-forget endpoint called by the client when a
   * call ends.  Records supplementary metadata (duration, etc.) against the
   * existing call session document.  Returns 204 on success.
   */
  @Post('history')
  @HttpCode(204)
  async recordCallEnd(
    @Req() req: FastifyRequest,
    @Body()
    body: {
      call_id?: string
      call_type?: string
      duration_ms?: number
      started_at?: string
      ended_at?: string
    },
  ) {
    // Validate auth — throw 401 if missing/invalid; otherwise silently accept.
    await this.resolveUser(req)
    // Best-effort: if we can locate the call document, stamp it with the
    // client-reported duration / ended_at.  Non-fatal if not found.
    if (body.call_id) {
      try {
        // We don't have the conversationId here, so use a lightweight query.
        // The service exposes endCall only by conversationId+callId, so we fall
        // back to a direct Mongoose patch through a new thin helper.
        await this.callsService.patchCallById(body.call_id, {
          ...(body.ended_at ? { endedAt: new Date(body.ended_at) } : {}),
        })
      } catch {
        // Non-fatal — the call may have already been ended by the server-side
        // socket handler, or the call_id may refer to a gateway-side UUID.
      }
    }
    // Returns 204 No Content implicitly (HttpCode decorator).
  }
}
