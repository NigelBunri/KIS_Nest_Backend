// src/realtime/handlers/pins.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface PinsDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
  pinsService: {
    setPinned(args: {
      conversationId: string
      messageId: string
      userId: string
      pinned: boolean
    }): Promise<{ pinned: boolean }>
  }
  starsService: {
    setStarred(args: {
      userId: string
      conversationId: string
      messageId: string
      starred: boolean
    }): Promise<{ starred: boolean }>
    listStarredMessageIds(args: {
      userId: string
      conversationId: string
      limit?: number
    }): Promise<{ messageIds: string[] }>
  }
}

export function registerPinHandlers(server: Server, socket: Socket, deps: PinsDeps) {
  socket.on(EVT.PIN_SET, async (payload: { conversationId: string; messageId: string; pinned: boolean }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { conversationId, messageId, pinned } = payload || ({} as any)

    if (!conversationId || !messageId || typeof pinned !== 'boolean') {
      return safeAck(ack, err('conversationId, messageId, pinned are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `pin_set:${conversationId}`, 60)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      await deps.pinsService.setPinned({
        conversationId,
        messageId,
        userId: principal.userId,
        pinned,
      })

      safeEmit(server, rooms.convRoom(conversationId), EVT.PIN_SET, {
        messageId,
        pinned,
        conversationId,
      })
      safeAck(ack, ok({ pinned }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Pin set failed', 'ERROR'))
    }
  })

  socket.on(EVT.STAR_SET, async (payload: { messageId: string; conversationId?: string; starred: boolean }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { messageId, starred } = payload || ({} as any)
    const conversationId = (payload as any)?.conversationId ?? ''

    if (!messageId || typeof starred !== 'boolean') {
      return safeAck(ack, err('messageId, starred are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `star_set:${principal.userId}`, 120)

      await deps.starsService.setStarred({
        userId: principal.userId,
        conversationId,
        messageId,
        starred,
      })

      socket.emit(EVT.STAR_SET, {
        messageId,
        starred,
        conversationId,
        userId: principal.userId,
      })
      safeAck(ack, ok({ starred }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Star set failed', 'ERROR'))
    }
  })

  socket.on(EVT.GET_STARRED, async (payload: { conversationId: string; limit?: number }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { conversationId, limit } = payload || {}

    if (!conversationId) {
      return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))
    }

    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      const { messageIds } = await deps.starsService.listStarredMessageIds({
        userId: principal.userId,
        conversationId,
        limit,
      })
      safeAck(ack, ok({ messageIds }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Get starred failed', 'ERROR'))
    }
  })
}
