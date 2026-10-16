// src/realtime/handlers/polls.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface PollsDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
  messagesService: {
    votePoll(args: {
      conversationId: string
      messageId: string
      optionId: string
      userId: string
    }): Promise<any>
    closePoll(args: {
      conversationId: string
      messageId: string
      userId: string
    }): Promise<any>
  }
}

export function registerPollHandlers(server: Server, socket: Socket, deps: PollsDeps) {
  socket.on(
    EVT.VOTE_POLL,
    async (
      payload: { conversationId: string; messageId: string; optionId: string },
      ack?: (a: Ack<any>) => void,
    ) => {
      const principal = getPrincipal(socket)
      const { conversationId, messageId, optionId } = payload || ({} as any)

      if (!conversationId || !messageId || !optionId) {
        return safeAck(ack, err('conversationId, messageId, optionId are required', 'BAD_REQUEST'))
      }

      try {
        await deps.rateLimitService.assert(principal, `vote_poll:${conversationId}`, 30)
        await deps.djangoConversationClient.assertMember(principal, conversationId)

        const updatedMsg = await deps.messagesService.votePoll({
          conversationId,
          messageId,
          optionId,
          userId: principal.userId,
        })

        safeEmit(server, rooms.convRoom(conversationId), EVT.POLL_UPDATED, {
          conversationId,
          messageId,
          poll: (updatedMsg as any)?.poll,
        })
        // Carries the server's own resulting poll back in the ack too -
        // the voter's device no longer has to trust its own optimistic
        // guess forever; it reconciles against this the moment the ack
        // lands, same as every other mutation in this codebase that waits
        // on an ack (edit/delete) rather than firing blind.
        safeAck(ack, ok({ voted: true, poll: (updatedMsg as any)?.poll }))
      } catch (e: any) {
        safeAck(ack, err(e?.message ?? 'Poll vote failed', 'ERROR'))
      }
    },
  )

  socket.on(
    EVT.CLOSE_POLL,
    async (
      payload: { conversationId: string; messageId: string },
      ack?: (a: Ack<any>) => void,
    ) => {
      const principal = getPrincipal(socket)
      const { conversationId, messageId } = payload || ({} as any)

      if (!conversationId || !messageId) {
        return safeAck(ack, err('conversationId, messageId are required', 'BAD_REQUEST'))
      }

      try {
        await deps.rateLimitService.assert(principal, `close_poll:${conversationId}`, 10)
        await deps.djangoConversationClient.assertMember(principal, conversationId)

        const updatedMsg = await deps.messagesService.closePoll({
          conversationId,
          messageId,
          userId: principal.userId,
        })

        safeEmit(server, rooms.convRoom(conversationId), EVT.POLL_UPDATED, {
          conversationId,
          messageId,
          poll: (updatedMsg as any)?.poll,
        })
        safeAck(ack, ok({ closed: true, poll: (updatedMsg as any)?.poll }))
      } catch (e: any) {
        safeAck(ack, err(e?.message ?? 'Poll close failed', 'ERROR'))
      }
    },
  )
}
