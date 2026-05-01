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
    createCallOrThrowIfActiveInConversation?(args: {
      conversationId: string
      callId: string
      createdBy: string
      media?: string
      inviteeUserIds?: string[]
    }): Promise<any>
    ensureCallExistsOrThrow?(conversationId: string, callId: string): Promise<any>
    markActive?(conversationId: string, callId: string): Promise<any>
    setParticipantStatus?(
      conversationId: string,
      callId: string,
      userId: string,
      status: 'invited' | 'connecting' | 'joined' | 'left' | 'rejected' | 'busy',
      reason?: string,
    ): Promise<any>
    appendSignal?(
      conversationId: string,
      callId: string,
      evt: {
        kind: 'offer' | 'answer' | 'ice' | 'renegotiate' | 'hangup'
        fromUserId: string
        toUserId?: string | null
        payloadType?: string | null
        createdAt?: Date
      },
    ): Promise<void>
    endCall?(
      conversationId: string,
      callId: string,
      endedByUserId: string,
      reason?: string,
    ): Promise<any>
    endIfNoActiveParticipants?(conversationId: string, callId: string): Promise<void>
    upsertState?(args: { conversationId: string; state: Record<string, unknown> }): Promise<void>
    clearState?(args: { conversationId: string }): Promise<void>
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

      const callId = typeof payload?.callId === 'string' ? payload.callId : undefined
      const enrichedPayload: Record<string, unknown> = {
        ...(payload ?? {}),
        conversationId,
        fromUserId: principal.userId,
        deviceId: principal.deviceId ?? null,
      }

      if (callId && deps.callsService) {
        if (event === EVT.CALL_OFFER) {
          const inviteeUserIds = Array.isArray(payload?.inviteeUserIds)
            ? payload.inviteeUserIds.map(String).filter((id) => id && id !== principal.userId)
            : []
          if (deps.callsService.createCallOrThrowIfActiveInConversation) {
            await deps.callsService.createCallOrThrowIfActiveInConversation({
              conversationId,
              callId,
              createdBy: principal.userId,
              media: typeof payload?.media === 'string' ? payload.media : undefined,
              inviteeUserIds,
            })
          } else if (deps.callsService.upsertState) {
            await deps.callsService.upsertState({ conversationId, state: payload })
          }
          await deps.callsService.appendSignal?.(conversationId, callId, {
            kind: 'offer',
            fromUserId: principal.userId,
            payloadType: 'offer',
          })
        }

        if (event === EVT.CALL_ANSWER) {
          await deps.callsService.ensureCallExistsOrThrow?.(conversationId, callId)
          await deps.callsService.markActive?.(conversationId, callId)
          await deps.callsService.setParticipantStatus?.(
            conversationId,
            callId,
            principal.userId,
            'joined',
          )
          enrichedPayload.acceptedBy = principal.userId
          enrichedPayload.acceptedAt = new Date().toISOString()
          await deps.callsService.appendSignal?.(conversationId, callId, {
            kind: 'answer',
            fromUserId: principal.userId,
            payloadType: 'answer',
          })
        }

        if (event === EVT.CALL_ICE) {
          await deps.callsService.ensureCallExistsOrThrow?.(conversationId, callId)
          await deps.callsService.appendSignal?.(conversationId, callId, {
            kind: 'ice',
            fromUserId: principal.userId,
            toUserId: typeof payload?.toUserId === 'string' ? payload.toUserId : null,
            payloadType: typeof payload?.payloadType === 'string' ? payload.payloadType : 'ice',
          })
        }

        if (event === EVT.CALL_END) {
          const reason =
            typeof payload?.reason === 'string' && payload.reason.trim()
              ? payload.reason.trim()
              : 'ended'
          await deps.callsService.ensureCallExistsOrThrow?.(conversationId, callId)
          if (reason === 'rejected' || reason === 'busy') {
            await deps.callsService.setParticipantStatus?.(
              conversationId,
              callId,
              principal.userId,
              reason === 'busy' ? 'busy' : 'rejected',
              reason,
            )
            await deps.callsService.endIfNoActiveParticipants?.(conversationId, callId)
          } else {
            await deps.callsService.endCall?.(conversationId, callId, principal.userId, reason)
          }
          await deps.callsService.appendSignal?.(conversationId, callId, {
            kind: 'hangup',
            fromUserId: principal.userId,
            payloadType: reason,
          })
          if (deps.callsService.clearState && !deps.callsService.endCall) {
            await deps.callsService.clearState({ conversationId })
          }
          enrichedPayload.endedBy = principal.userId
          enrichedPayload.endedAt = new Date().toISOString()
        }
      }

      safeEmit(server, rooms.convRoom(conversationId), event, enrichedPayload)
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
