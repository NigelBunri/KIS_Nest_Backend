import { Body, Controller, Post, UseGuards } from '@nestjs/common'

import { InternalAuthGuard } from '../auth/internal-auth.guard'
import { rooms } from '../chat/chat.types'
import { ChatGateway } from './chat.gateway'

type ConversationCreatedPayload = {
  conversationId: string
  userIds: string[]
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
}
