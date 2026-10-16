// src/chat/features/scheduled-messages/scheduled-messages.controller.ts

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { ScheduledMessagesService } from './scheduled-messages.service'
import { ScheduledMessagesCron } from './scheduled-messages.cron'
import { DjangoAuthService } from '../../../auth/django-auth.service'
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client'
import { ModerationService } from '../moderation/moderation.service'

function toClientView(doc: any) {
  return {
    id: String(doc._id),
    conversationId: doc.conversationId,
    scheduledAt: doc.scheduledAt?.toISOString?.() ?? doc.scheduledAt,
    status: doc.status,
    attempts: doc.attempts,
    lastError: doc.status === 'failed' ? doc.lastError : undefined,
    sentMessageId: doc.sentMessageId,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
    // Only what the pending-list UI needs for a preview — never ships the
    // full encrypted/plaintext payload back wholesale.
    preview: {
      kind: doc.payload?.kind,
      text: doc.payload?.ciphertext ? undefined : doc.payload?.text,
      hasAttachment: Array.isArray(doc.payload?.attachments) && doc.payload.attachments.length > 0,
    },
  }
}

@Controller('chat/scheduled-messages')
export class ScheduledMessagesController {
  constructor(
    private readonly scheduledMessagesService: ScheduledMessagesService,
    private readonly scheduledMessagesCron: ScheduledMessagesCron,
    private readonly authService: DjangoAuthService,
    private readonly djangoConversationClient: DjangoConversationClient,
    private readonly moderationService: ModerationService,
  ) {}

  private async resolveUser(req: FastifyRequest) {
    const authHeader = req.headers.authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token')
    }
    const token = authHeader.slice('Bearer '.length)
    const deviceId = req.headers['x-device-id']
    const principal = await this.authService.introspect(token, typeof deviceId === 'string' ? deviceId : undefined)
    return { principal, token }
  }

  @Post()
  async schedule(@Req() req: FastifyRequest, @Body() body: Record<string, any>) {
    const { principal, token } = await this.resolveUser(req)
    const { conversationId, clientId, kind, scheduledAt, ...rest } = body || {}

    if (!conversationId || !clientId || !kind || !scheduledAt) {
      throw new BadRequestException('conversationId, clientId, kind, and scheduledAt are required')
    }
    const scheduledDate = new Date(scheduledAt)
    if (Number.isNaN(scheduledDate.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid ISO 8601 date')
    }

    // Same authorization sequence an immediate send runs, so a scheduled
    // message can't be created into a conversation the sender can't
    // actually send in — fail fast rather than only discovering this at
    // delivery time, hours or days later.
    const perms = await this.djangoConversationClient.assertMember(
      { userId: principal.userId, deviceId: principal.deviceId, token } as any,
      conversationId,
    )
    const canSend = perms?.isMember === true && perms?.isBlocked !== true && perms?.canSend !== false
    if (!canSend) throw new UnauthorizedException('Send not allowed in this conversation')
    await this.moderationService.assertAllowed({ conversationId, userId: principal.userId, action: 'send' })

    const doc = await this.scheduledMessagesService.schedule({
      conversationId,
      senderId: principal.userId,
      senderDeviceId: principal.deviceId,
      senderName: principal.username,
      clientId,
      payload: { conversationId, clientId, kind, ...rest },
      scheduledAt: scheduledDate,
    })

    return { ok: true, data: toClientView(doc) }
  }

  @Get()
  async listPending(
    @Req() req: FastifyRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const { principal } = await this.resolveUser(req)
    const { items, nextCursor } = await this.scheduledMessagesService.listPending({
      senderId: principal.userId,
      limit: limit ? Number(limit) : undefined,
      cursor,
    })
    return { ok: true, data: items.map(toClientView), nextCursor }
  }

  @Patch(':id')
  async reschedule(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { scheduledAt?: string; payload?: Record<string, any> },
  ) {
    const { principal } = await this.resolveUser(req)
    const scheduledAt = body?.scheduledAt ? new Date(body.scheduledAt) : undefined
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid ISO 8601 date')
    }

    const result = await this.scheduledMessagesService.reschedule({
      id,
      senderId: principal.userId,
      scheduledAt,
      payload: body?.payload,
    })

    if (!result.ok) {
      return {
        ok: false,
        error: `Cannot edit — this message is already ${result.status}`,
        status: result.status,
      }
    }
    return { ok: true, data: toClientView(result.doc) }
  }

  @Delete(':id')
  async cancel(@Req() req: FastifyRequest, @Param('id') id: string) {
    const { principal } = await this.resolveUser(req)
    const result = await this.scheduledMessagesService.cancel({ id, senderId: principal.userId })

    if (!result.ok) {
      return {
        ok: false,
        error: `Cannot cancel — this message is already ${result.status}`,
        status: result.status,
      }
    }

    const doc = await this.scheduledMessagesService.getOwned(id, principal.userId)
    this.scheduledMessagesCron.notifyOwnerOfStatus(doc, 'cancelled')
    return { ok: true, status: 'cancelled' }
  }
}
