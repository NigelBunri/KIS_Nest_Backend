// src/realtime/handlers/rooms.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface RoomsDeps {
  // Django ws-perms client (source of truth)
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
}

export function registerRoomHandlers(server: Server, socket: Socket, deps: RoomsDeps) {
  socket.on(EVT.JOIN, async (payload: { conversationId: string }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId

    if (!conversationId) return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))

    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      socket.join(rooms.userRoom(principal.userId))
      socket.join(rooms.convRoom(conversationId))

      safeEmit(server, rooms.convRoom(conversationId), EVT.PRESENCE, {
        conversationId,
        userId: principal.userId,
        isOnline: true,
        at: new Date().toISOString(),
      })

      try {
        const sockets = await server.in(rooms.convRoom(conversationId)).fetchSockets()
        for (const s of sockets) {
          const p = (s as any).principal as SocketPrincipal | undefined
          if (!p?.userId) continue
          socket.emit(EVT.PRESENCE, {
            conversationId,
            userId: p.userId,
            isOnline: true,
            at: new Date().toISOString(),
          })
        }
      } catch {}

      safeAck(ack, ok({ joined: true }))
    } catch (e: any) {
      try {
        socket.disconnect(true)
      } catch {}
      safeAck(ack, err(e?.message ?? 'Join denied', 'UNAUTHORIZED'))
    }
  })

  socket.on(EVT.LEAVE, async (payload: { conversationId: string }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId

    if (!conversationId) return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))

    try {
      // leaving is always allowed; no auth check required
      socket.leave(rooms.convRoom(conversationId))
      socket.join(rooms.userRoom(principal.userId)) // keep user room

      safeAck(ack, ok({ left: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Leave failed', 'ERROR'))
    }
  })
}
