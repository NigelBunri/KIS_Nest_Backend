import {
  Body,
  Controller,
  Get,
  HttpCode,
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
