import { Body, Controller, Post, UseGuards } from '@nestjs/common'

import { InternalAuthGuard } from '../../../auth/internal-auth.guard'
import { MessagesService } from '../messages/messages.service'

type ChannelMessagesPayload = {
  conversationIds?: string[]
  conversationId?: string
  messageIds?: string[]
  since?: string
  limit?: number
}

@Controller('internal/broadcasts')
@UseGuards(InternalAuthGuard)
export class BroadcastsController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('channel-messages')
  async listChannelMessages(@Body() body: ChannelMessagesPayload) {
    const messageIds = Array.isArray(body?.messageIds)
      ? body?.messageIds.map((id) => String(id)).filter(Boolean)
      : []
    const conversationId = body?.conversationId ? String(body.conversationId) : undefined
    const conversationIds = Array.isArray(body?.conversationIds)
      ? body?.conversationIds.map((id) => String(id)).filter(Boolean)
      : []
    const limit = Number.isFinite(body?.limit) ? Math.floor(Number(body?.limit)) : 100
    const since = body?.since ? new Date(body.since) : undefined

    if (messageIds.length) {
      const messages = await this.messagesService.listByIds({
        messageIds,
        conversationId,
      })
      return { ok: true, messages }
    }

    if (!conversationIds.length) {
      return { ok: true, messages: [] }
    }

    const messages = await this.messagesService.listRecentForConversations({
      conversationIds,
      limit,
      since,
    })

    return { ok: true, messages }
  }
}
