// src/realtime/handlers/typing.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface TypingDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  moderationService?: {
    assertAllowed(args: { conversationId: string; userId: string; action: 'typing' }): Promise<void> | void
  }
  djangoConversationClient?: {
    listMemberIds?: (conversationId: string) => Promise<string[]>
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

        // Membership was already verified when the socket joined the conv room.
        // Re-calling assertMember on every keystroke would hit Django every 2 min
        // and stall the indicator whenever Django is slow. Trust room membership.
        if (!socket.rooms.has(rooms.convRoom(conversationId))) {
          return safeAck(ack, err('Not in conversation room', 'UNAUTHORIZED'))
        }

        if (deps.moderationService) {
          await deps.moderationService.assertAllowed({
            conversationId,
            userId: principal.userId,
            action: 'typing',
          })
        }

        const typingPayload = {
          conversationId,
          userId: principal.userId,
          senderName: principal.username ?? undefined,
          isTyping: !!payload?.isTyping,
          threadId: payload?.threadId ?? null,
          at: new Date().toISOString(),
        }

        safeEmit(server, rooms.convRoom(conversationId), EVT.TYPING, typingPayload)

        // Also broadcast to each member's userRoom, not just the conv room.
        // The conv room only has members who are ACTIVELY VIEWING this exact
        // conversation right now (see chat.join/chat.leave) — someone sitting
        // on the chat LIST screen never joins it, so without this they'd
        // never see a "typing…" indicator on that list item at all.
        if (deps.djangoConversationClient?.listMemberIds) {
          const memberIds = await deps.djangoConversationClient.listMemberIds(conversationId).catch(() => [] as string[])
          for (const memberId of memberIds) {
            if (String(memberId) === String(principal.userId)) continue
            safeEmit(server, rooms.userRoom(String(memberId)), EVT.TYPING, typingPayload)
          }
        }

        safeAck(ack, ok({ typing: true }))
      } catch (e: any) {
        safeAck(ack, err(e?.message ?? 'Typing failed', 'ERROR'))
      }
    },
  )
}
