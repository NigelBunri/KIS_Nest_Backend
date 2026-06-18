// src/realtime/handlers/disappearing.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

const MAX_TTL_SECONDS = 604800 // 7 days

export interface DisappearingDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
}

// In-memory store keyed by conversationId — survives per-process, not per-restart.
// Replace with a dedicated Mongo collection for full persistence.
const disappearSettings = new Map<string, { ttlSeconds: number | null; updatedBy: string; updatedAt: number }>()

export function registerDisappearingHandlers(server: Server, socket: Socket, deps: DisappearingDeps) {
  socket.on(
    EVT.DISAPPEAR_SET,
    async (
      payload: { conversationId: string; ttlSeconds: number | null },
      ack?: (a: Ack<any>) => void,
    ) => {
      const principal = getPrincipal(socket)
      const { conversationId, ttlSeconds } = payload || ({} as any)

      if (!conversationId) {
        return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))
      }
      if (ttlSeconds !== null) {
        if (
          typeof ttlSeconds !== 'number' ||
          !Number.isInteger(ttlSeconds) ||
          ttlSeconds <= 0 ||
          ttlSeconds > MAX_TTL_SECONDS
        ) {
          return safeAck(
            ack,
            err(`ttlSeconds must be null or a positive integer ≤ ${MAX_TTL_SECONDS}`, 'BAD_REQUEST'),
          )
        }
      }

      try {
        await deps.rateLimitService.assert(principal, `disappear:${conversationId}`, 10)
        await deps.djangoConversationClient.assertMember(principal, conversationId)

        disappearSettings.set(conversationId, {
          ttlSeconds,
          updatedBy: principal.userId,
          updatedAt: Date.now(),
        })

        safeEmit(server, rooms.convRoom(conversationId), EVT.DISAPPEAR_UPDATE, {
          conversationId,
          ttlSeconds,
          updatedBy: principal.userId,
        })
        safeAck(ack, ok({ ttlSeconds }))
      } catch (e: any) {
        safeAck(ack, err(e?.message ?? 'Disappear set failed', 'ERROR'))
      }
    },
  )
}
