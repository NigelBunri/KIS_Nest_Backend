import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { ModerationService } from './moderation.service'
import { DjangoAuthService } from '../../../auth/django-auth.service'
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client'

type ReportPayload = {
  conversationId: string
  messageId: string
  reason?: string
  note?: string
}

type BlockPayload = {
  conversationId: string
  blocked: boolean
}

type MutePayload = {
  conversationId: string
  muted: boolean
  untilMs?: number
}

@Controller('moderation')
export class ModerationController {
  constructor(
    private readonly moderationService: ModerationService,
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

  @Post('report')
  async report(@Req() req: FastifyRequest, @Body() body: ReportPayload) {
    const { principal, token } = await this.resolveUser(req)
    const { conversationId, messageId, reason, note } = body || ({} as ReportPayload)
    if (!conversationId || !messageId) {
      return { ok: false, error: 'conversationId and messageId are required' }
    }

    await this.djangoConversationClient.assertMember(
      { userId: principal.userId, token },
      conversationId,
    )

    await this.moderationService.reportMessage({
      conversationId,
      messageId,
      reportedBy: principal.userId,
      reason,
      note,
    })

    return { ok: true }
  }

  @Post('block')
  async block(@Req() req: FastifyRequest, @Body() body: BlockPayload) {
    const { principal, token } = await this.resolveUser(req)
    const { conversationId, blocked } = body || ({} as BlockPayload)
    if (!conversationId || typeof blocked !== 'boolean') {
      return { ok: false, error: 'conversationId and blocked are required' }
    }

    await this.djangoConversationClient.assertMember(
      { userId: principal.userId, token },
      conversationId,
    )

    const res = await this.moderationService.setBlocked({
      conversationId,
      userId: principal.userId,
      blocked,
    })

    return { ok: true, data: res }
  }

  @Post('mute')
  async mute(@Req() req: FastifyRequest, @Body() body: MutePayload) {
    const { principal, token } = await this.resolveUser(req)
    const { conversationId, muted, untilMs } = body || ({} as MutePayload)
    if (!conversationId || typeof muted !== 'boolean') {
      return { ok: false, error: 'conversationId and muted are required' }
    }

    await this.djangoConversationClient.assertMember(
      { userId: principal.userId, token },
      conversationId,
    )

    const res = await this.moderationService.setMuted({
      conversationId,
      userId: principal.userId,
      muted,
      untilMs,
    })

    return { ok: true, data: res }
  }
}
