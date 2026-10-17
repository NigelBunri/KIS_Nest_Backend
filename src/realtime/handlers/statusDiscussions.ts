// src/realtime/handlers/statusDiscussions.ts
//
// Live-update channel for a status's reaction/comment discussion. Django
// (apps.statuses) owns all the real data and every permission decision -
// this room only exists so a client with the interaction sheet already
// open sees a new reaction/comment land without having to poll or
// manually refresh. If the push never arrives (socket down, Nest
// unreachable, event dropped), the sheet's own refetch-on-open/pull-to-
// refresh path is what actually keeps it correct - this is a convenience
// layer on top of an always-authoritative REST read, never a replacement
// for it.

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'

import { EVT, rooms, type Ack } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck } from './utils'

const logger = new Logger('StatusDiscussionHandlers')

export interface StatusDiscussionDeps {
  djangoConversationClient: {
    canViewStatus(userId: string, statusId: string): Promise<boolean>
  }
}

export function registerStatusDiscussionHandlers(
  _server: Server,
  socket: Socket,
  deps: StatusDiscussionDeps,
) {
  socket.on(EVT.STATUS_JOIN, async (payload: { statusId?: string }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const statusId = typeof payload?.statusId === 'string' ? payload.statusId.trim() : ''
    if (!statusId) return safeAck(ack, err('statusId is required', 'BAD_REQUEST'))

    try {
      const canView = await deps.djangoConversationClient.canViewStatus(principal.userId, statusId)
      if (!canView) {
        // Same hide-not-reveal posture as every REST path for this status -
        // don't distinguish "doesn't exist" from "you can't see it".
        return safeAck(ack, err('Status not found', 'NOT_FOUND'))
      }
      socket.join(rooms.statusRoom(statusId))
      safeAck(ack, ok({ joined: true, statusId }))
    } catch (error: any) {
      logger.error(`[statusDiscussions] join failed statusId=${statusId} userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Could not join status room', 'ERROR'))
    }
  })

  socket.on(EVT.STATUS_LEAVE, (payload: { statusId?: string }, ack?: (a: Ack<any>) => void) => {
    const statusId = typeof payload?.statusId === 'string' ? payload.statusId.trim() : ''
    if (statusId) socket.leave(rooms.statusRoom(statusId))
    safeAck(ack, ok({ left: true, statusId }))
  })
}
