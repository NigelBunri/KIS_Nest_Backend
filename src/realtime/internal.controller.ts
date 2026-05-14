import { Body, Controller, Post, UseGuards } from '@nestjs/common'

import { InternalAuthGuard } from '../auth/internal-auth.guard'
import { rooms } from '../chat/chat.types'
import { ChatGateway } from './chat.gateway'

type ConversationCreatedPayload = {
  conversationId: string
  userIds: string[]
}

type MainTabBadgesUpdatedPayload = {
  event?: string
  userIds: string[]
  source?: string
  reason?: string
  extra?: Record<string, unknown>
}

@Controller('internal')
@UseGuards(InternalAuthGuard)
export class RealtimeInternalController {
  constructor(private readonly gateway: ChatGateway) {}

  @Post('conversations/created')
  handleConversationCreated(@Body() payload: ConversationCreatedPayload) {
    const conversationId = String(payload?.conversationId ?? '')
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : []
    if (!conversationId || userIds.length === 0) {
      return { ok: false }
    }

    for (const userId of userIds) {
      if (!userId) continue
      try {
        this.gateway.server
          ?.to(rooms.userRoom(String(userId)))
          .emit('conversation.created', {
            conversationId,
            userId: String(userId),
          })
      } catch {}
    }

    return { ok: true }
  }

  @Post('main-tab-badges/updated')
  handleMainTabBadgesUpdated(@Body() payload: MainTabBadgesUpdatedPayload) {
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : []
    const cleanUserIds = Array.from(
      new Set(userIds.map((value) => String(value || '').trim()).filter(Boolean)),
    )
    if (cleanUserIds.length === 0) {
      return { ok: false }
    }

    const event = 'main_tab_badges.updated'
    const body = {
      event,
      source: String(payload?.source || 'unknown'),
      reason: String(payload?.reason || ''),
      extra: payload?.extra || {},
      at: new Date().toISOString(),
    }

    for (const userId of cleanUserIds) {
      try {
        this.gateway.server?.to(rooms.userRoom(userId)).emit(event, {
          ...body,
          userId,
        })
      } catch {}
    }

    return { ok: true, emitted: cleanUserIds.length }
  }
}
