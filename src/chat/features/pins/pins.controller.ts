import { Controller, Get, Post, Body, Query, Req, UnauthorizedException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { PinsService } from './pins.service'
import { DjangoAuthService } from '../../../auth/django-auth.service'
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client'

@Controller('pins')
export class PinsController {
  constructor(
    private readonly pinsService: PinsService,
    private readonly authService: DjangoAuthService,
    private readonly djangoConversationClient: DjangoConversationClient,
  ) {}

  private async resolveUser(req: FastifyRequest) {
    const authHeader = req.headers.authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token')
    }
    const token = authHeader.slice('Bearer '.length)
    const principal = await this.authService.introspect(token)
    return { principal, token }
  }

  @Post('set')
  async setPinned(
    @Req() req: FastifyRequest,
    @Body()
    body: { conversationId: string; messageId: string; pinned: boolean },
  ) {
    const { principal, token } = await this.resolveUser(req)
    const { conversationId, messageId, pinned } = body || ({} as any)
    if (!conversationId || !messageId || typeof pinned !== 'boolean') {
      return { ok: false, error: 'conversationId, messageId, pinned are required' }
    }

    await this.djangoConversationClient.assertMember(
      { userId: principal.userId, token },
      conversationId,
    )

    const res = await this.pinsService.setPinned({
      conversationId,
      messageId,
      userId: principal.userId,
      pinned,
    })

    return { ok: true, data: res }
  }

  @Get('list')
  async listPinned(
    @Req() req: FastifyRequest,
    @Query('conversationId') conversationId?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    if (!conversationId) {
      return { ok: false, error: 'conversationId is required' }
    }
    const { principal, token } = await this.resolveUser(req)
    await this.djangoConversationClient.assertMember(
      { userId: principal.userId, token },
      conversationId,
    )

    const parsedLimit = limit ? Number(limit) : undefined
    const res = await this.pinsService.listPinnedMessageIds({
      conversationId,
      limit: Number.isFinite(parsedLimit as number) ? parsedLimit : undefined,
      before,
    })
    return { ok: true, data: res }
  }
}
