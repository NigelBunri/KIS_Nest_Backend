// src/realtime/handlers/sync.ts

import type { Server, Socket } from 'socket.io'
import { EVT, type Ack, type GapCheckPayload, type GapFillPayload, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck } from './utils'

export interface SyncDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
  syncService: {
    findMissingSeqs(args: { conversationId: string; haveSeqs: number[] }): Promise<number[]>
    getRange(args: { conversationId: string; seqs: number[] }): Promise<any[]>
  }
}

export function registerSyncHandlers(server: Server, socket: Socket, deps: SyncDeps) {
  socket.on(EVT.GAP_CHECK, async (payload: GapCheckPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId

    if (!conversationId) return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))

    try {
      await deps.rateLimitService.assert(principal, `gap_check:${conversationId}`, 30)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      const haveSeqs = Array.isArray(payload?.haveSeqs) ? payload.haveSeqs : []
      const missingSeqs = await deps.syncService.findMissingSeqs({ conversationId, haveSeqs })

      safeAck(ack, ok({ missingSeqs }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Gap check failed', 'ERROR'))
    }
  })

  socket.on(EVT.GAP_FILL, async (payload: GapFillPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId

    if (!conversationId) return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))

    try {
      await deps.rateLimitService.assert(principal, `gap_fill:${conversationId}`, 20)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      const missingSeqs = Array.isArray(payload?.missingSeqs) ? payload.missingSeqs : []
      const messages = await deps.syncService.getRange({ conversationId, seqs: missingSeqs })

      safeAck(ack, ok({ messages }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Gap fill failed', 'ERROR'))
    }
  })
}
