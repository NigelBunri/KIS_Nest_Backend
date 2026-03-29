// src/realtime/handlers/calls.ts

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'

import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'
import type { RoomsDeps } from './rooms'

const logger = new Logger('ChatCallHandlers')

type CallSignalPayload = Record<string, unknown> & {
  conversationId?: string
  callId?: string
}

export interface CallsDeps {
  djangoConversationClient: RoomsDeps['djangoConversationClient']
  rateLimitService?: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  callsService?: {
    upsertState(args: { conversationId: string; state: Record<string, unknown> }): Promise<void>
    clearState(args: { conversationId: string }): Promise<void>
  }
}

function createCallHandler(
  event: typeof EVT.CALL_OFFER | typeof EVT.CALL_ANSWER | typeof EVT.CALL_ICE | typeof EVT.CALL_END,
  server: Server,
  socket: Socket,
  deps: CallsDeps,
) {
  return async (payload: CallSignalPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const conversationId = payload?.conversationId

    if (!conversationId) {
      return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService?.assert(principal, `call:${event}`, 20)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      if (event === EVT.CALL_OFFER && deps.callsService?.upsertState) {
        await deps.callsService.upsertState({ conversationId, state: payload })
      }

      if (event === EVT.CALL_END && deps.callsService?.clearState) {
        await deps.callsService.clearState({ conversationId })
      }

      safeEmit(server, rooms.convRoom(conversationId), event, payload)
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(
        `[calls] ${event} failed conversationId=${conversationId} userId=${principal?.userId}`,
        error?.stack ?? error?.message ?? error,
      )
      safeAck(ack, err(error?.message ?? 'Call event failed', 'ERROR'))
    }
  }
}

export function registerCallHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on(EVT.CALL_OFFER, createCallHandler(EVT.CALL_OFFER, server, socket, deps))
  socket.on(EVT.CALL_ANSWER, createCallHandler(EVT.CALL_ANSWER, server, socket, deps))
  socket.on(EVT.CALL_ICE, createCallHandler(EVT.CALL_ICE, server, socket, deps))
  socket.on(EVT.CALL_END, createCallHandler(EVT.CALL_END, server, socket, deps))
}
