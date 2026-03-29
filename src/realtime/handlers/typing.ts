// src/realtime/handlers/typing.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface TypingDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
  moderationService?: {
    assertAllowed(args: { conversationId: string; userId: string; action: 'typing' }): Promise<void> | void
  }
}

export function registerTypingHandlers(server: Server, socket: Socket, deps: TypingDeps) {
  socket.on(
    EVT.TYPING,
    async (
      payload: { conversationId: string; isTyping: boolean; threadId?: string },
      ack?: (a: Ack<any>) => void,
    ) => {
      const principal = getPrincipal(socket)
      const conversationId = payload?.conversationId

      if (!conversationId) return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))

      try {
        await deps.rateLimitService.assert(principal, `typing:${conversationId}`, 300)
        await deps.djangoConversationClient.assertMember(principal, conversationId)
        if (deps.moderationService) {
          await deps.moderationService.assertAllowed({
            conversationId,
            userId: principal.userId,
            action: 'typing',
          })
        }

        safeEmit(server, rooms.convRoom(conversationId), EVT.TYPING, {
          conversationId,
          userId: principal.userId,
          isTyping: !!payload?.isTyping,
          threadId: payload?.threadId ?? null,
          at: new Date().toISOString(),
        })

        safeAck(ack, ok({ typing: true }))
      } catch (e: any) {
        safeAck(ack, err(e?.message ?? 'Typing failed', 'ERROR'))
      }
    },
  )
}
