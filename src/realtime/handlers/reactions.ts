// src/realtime/handlers/reactions.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type ReactionPayload, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface ReactionsDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
  moderationService?: {
    assertAllowed(args: { conversationId: string; userId: string; action: 'react' }): Promise<void> | void
  }
  reactionsService: {
    toggleReaction(args: {
      userId: string
      conversationId: string
      messageId: string
      emoji: string
    }): Promise<any>
  }
}

export function registerReactionHandlers(server: Server, socket: Socket, deps: ReactionsDeps) {
  socket.on(EVT.REACT, async (payload: ReactionPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { conversationId, messageId, emoji } = payload || ({} as any)

    if (!conversationId || !messageId || !emoji) {
      return safeAck(ack, err('conversationId, messageId, emoji are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `react:${conversationId}`, 120)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (deps.moderationService) {
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'react',
        })
      }

      const reactionEvent = await deps.reactionsService.toggleReaction({
        userId: principal.userId,
        conversationId,
        messageId,
        emoji,
      })

      const reactionConvId = (reactionEvent as any)?.conversationId
      if (reactionConvId && String(reactionConvId) !== String(conversationId)) {
        throw new Error('Conversation mismatch on reaction')
      }

      safeEmit(server, rooms.convRoom(conversationId), EVT.MESSAGE_REACTION, reactionEvent)
      safeAck(ack, ok({ reacted: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'React failed', 'ERROR'))
    }
  })
}
