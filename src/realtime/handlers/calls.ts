// src/realtime/handlers/calls.ts

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'

import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'
import type { RoomsDeps } from './rooms'
import {
  validateSocketPayload,
  CallOfferDto,
  CallSignalDto,
  CallSdpDto,
  CallIceCandidateDto,
  CallHandDto,
  CallReactionDto,
  CallChatDto,
  CallParticipantActionDto,
} from '../socket-dto'

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
      callType?: string
      media?: string
      inviteeUserIds?: string[]
    }): Promise<any>
    ensureCallExistsOrThrow?(conversationId: string, callId: string): Promise<any>
    getCallCreator?(conversationId: string, callId: string): Promise<string | null>
    markActive?(conversationId: string, callId: string): Promise<any>
    setParticipantStatus?(
      conversationId: string,
      callId: string,
      userId: string,
      status: 'invited' | 'connecting' | 'joined' | 'left' | 'rejected' | 'busy',
      reason?: string,
    ): Promise<any>
    setParticipantRole?(
      conversationId: string,
      callId: string,
      userId: string,
      role: 'host' | 'co-host' | 'speaker' | 'audience',
    ): Promise<void>
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
    bumpViewerCount?(conversationId: string, callId: string, delta: 1 | -1): Promise<number>
    upsertState?(args: { conversationId: string; state: Record<string, unknown> }): Promise<void>
    clearState?(args: { conversationId: string }): Promise<void>
    getActiveCallsForUser?(userId: string): Promise<any[]>
    getParticipantsSnapshot?(conversationId: string, callId: string): Promise<any[]>
  }
}

// ─── Legacy signaling (call.offer / call.answer / call.ice / call.end) ───────

function createCallHandler(
  event: typeof EVT.CALL_OFFER | typeof EVT.CALL_ANSWER | typeof EVT.CALL_ICE | typeof EVT.CALL_END,
  server: Server,
  socket: Socket,
  deps: CallsDeps,
) {
  return async (payload: CallSignalPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)

    const DtoClass = event === EVT.CALL_OFFER ? CallOfferDto : CallSignalDto
    const validation = await validateSocketPayload(DtoClass, payload)
    if (!validation.ok) {
      return safeAck(ack, err(validation.errors.join('; '), 'BAD_REQUEST'))
    }

    const conversationId = payload?.conversationId
    if (!conversationId) {
      return safeAck(ack, err('conversationId required', 'BAD_REQUEST'))
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

      // Collect invitee IDs for CALL_OFFER — needed for routing below
      const offerInviteeIds: string[] =
        event === EVT.CALL_OFFER && Array.isArray(payload?.inviteeUserIds)
          ? payload.inviteeUserIds.map(String).filter((id) => id && id !== principal.userId)
          : []

      if (callId && deps.callsService) {
        if (event === EVT.CALL_OFFER) {
          const callType = typeof payload?.callType === 'string' ? payload.callType : undefined
          const media = typeof payload?.media === 'string' ? payload.media : undefined

          if (deps.callsService.createCallOrThrowIfActiveInConversation) {
            await deps.callsService.createCallOrThrowIfActiveInConversation({
              conversationId,
              callId,
              createdBy: principal.userId,
              callType,
              media,
              inviteeUserIds: offerInviteeIds,
            })
          } else if (deps.callsService.upsertState) {
            await deps.callsService.upsertState({ conversationId, state: payload as Record<string, unknown> })
          }
          await deps.callsService.appendSignal?.(conversationId, callId, {
            kind: 'offer',
            fromUserId: principal.userId,
            payloadType: 'offer',
          })
        }

        if (event === EVT.CALL_ANSWER) {
          await deps.callsService.ensureCallExistsOrThrow?.(conversationId, callId)
          const activatedCall = await deps.callsService.markActive?.(conversationId, callId)
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
          // Notify all conv participants that this user joined
          safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_PARTICIPANT_JOINED, {
            callId,
            conversationId,
            userId: principal.userId,
            joinedAt: enrichedPayload.acceptedAt,
          })
          // For broadcast calls: audience members bump the viewer count
          if (
            activatedCall?.callType === 'broadcast' &&
            activatedCall?.createdBy !== principal.userId &&
            deps.callsService.bumpViewerCount
          ) {
            const count = await deps.callsService.bumpViewerCount(conversationId, callId, 1)
            safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_VIEWER_COUNT, {
              callId,
              conversationId,
              viewerCount: count,
            })
          }
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
          const existingCall = await deps.callsService.ensureCallExistsOrThrow?.(conversationId, callId)
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
          // Notify conv that this participant left
          safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_PARTICIPANT_LEFT, {
            callId,
            conversationId,
            userId: principal.userId,
            reason,
            leftAt: enrichedPayload.endedAt,
          })
          // Decrement broadcast viewer count if audience member left
          if (
            existingCall?.callType === 'broadcast' &&
            existingCall?.createdBy !== principal.userId &&
            deps.callsService.bumpViewerCount
          ) {
            const count = await deps.callsService.bumpViewerCount(conversationId, callId, -1)
            safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_VIEWER_COUNT, {
              callId,
              conversationId,
              viewerCount: count,
            })
          }
        }
      }

      safeEmit(server, rooms.convRoom(conversationId), event, enrichedPayload)

      // call.offer: invitees are typically NOT in the conv room (they have a
      // different screen open). Deliver directly to their user rooms AND pull
      // all their sockets into the conv room so subsequent signaling events
      // (call.answer, ICE, SDP) are received without an extra round-trip.
      if (event === EVT.CALL_OFFER && offerInviteeIds.length > 0) {
        for (const uid of offerInviteeIds) {
          safeEmit(server, rooms.userRoom(uid), EVT.CALL_OFFER, enrichedPayload)
          server.in(rooms.userRoom(uid)).socketsJoin(rooms.convRoom(conversationId))
        }
        // Also ensure the caller's sockets are in the conv room
        server.in(rooms.userRoom(principal.userId)).socketsJoin(rooms.convRoom(conversationId))
      }

      // call.answer: make sure the answer reaches the caller even if they
      // navigated away from the chat while waiting.
      if (event === EVT.CALL_ANSWER && callId && deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId).catch(() => null)
        if (creator && creator !== principal.userId) {
          safeEmit(server, rooms.userRoom(creator), EVT.CALL_ANSWER, enrichedPayload)
          server.in(rooms.userRoom(creator)).socketsJoin(rooms.convRoom(conversationId))
        }
      }

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

// ─── WebRTC peer-to-peer signaling (SDP offer/answer, ICE candidates) ────────

function registerWebRTCHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  // call.sdp.offer — relay SDP offer to specific peer only
  socket.on(EVT.CALL_SDP_OFFER, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallSdpDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId, targetUserId, sdp, sdpType } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:sdp', 60)
      // Sockets are forced into the conv room when call.offer is processed —
      // trust that membership rather than hitting Django on every SDP frame.
      if (!socket.rooms.has(rooms.convRoom(conversationId))) {
        await deps.djangoConversationClient.assertMember(principal, conversationId)
      }

      safeEmit(server, rooms.userRoom(targetUserId), EVT.CALL_SDP_OFFER, {
        conversationId,
        callId,
        fromUserId: principal.userId,
        sdp,
        sdpType: sdpType ?? 'offer',
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.sdp.offer failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'SDP relay failed', 'ERROR'))
    }
  })

  // call.sdp.answer — relay SDP answer to specific peer only
  socket.on(EVT.CALL_SDP_ANSWER, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallSdpDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId, targetUserId, sdp } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:sdp', 60)
      if (!socket.rooms.has(rooms.convRoom(conversationId))) {
        await deps.djangoConversationClient.assertMember(principal, conversationId)
      }

      safeEmit(server, rooms.userRoom(targetUserId), EVT.CALL_SDP_ANSWER, {
        conversationId,
        callId,
        fromUserId: principal.userId,
        sdp,
        sdpType: 'answer',
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.sdp.answer failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'SDP relay failed', 'ERROR'))
    }
  })

  // call.ice.candidate — relay ICE candidate to specific peer only
  socket.on(EVT.CALL_ICE_CANDIDATE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallIceCandidateDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId, targetUserId, candidate } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:ice', 300)
      if (!socket.rooms.has(rooms.convRoom(conversationId))) {
        await deps.djangoConversationClient.assertMember(principal, conversationId)
      }

      safeEmit(server, rooms.userRoom(targetUserId), EVT.CALL_ICE_CANDIDATE, {
        conversationId,
        callId,
        fromUserId: principal.userId,
        candidate,
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.ice.candidate failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'ICE relay failed', 'ERROR'))
    }
  })

  // call.ice.restart — relay ICE restart signal to target peer
  socket.on('call.ice.restart', async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const targetUserId = typeof p.targetUserId === 'string' ? p.targetUserId : null
    if (!conversationId || !callId || !targetUserId) {
      return safeAck(ack, err('conversationId, callId, targetUserId required', 'BAD_REQUEST'))
    }
    try {
      await deps.rateLimitService?.assert(principal, 'call:ice:restart', 10)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      await deps.callsService?.appendSignal?.(conversationId, callId, {
        kind: 'renegotiate',
        fromUserId: principal.userId,
        toUserId: targetUserId,
        payloadType: 'ice_restart',
      })
      safeEmit(server, rooms.userRoom(targetUserId), 'call.ice.restart', {
        conversationId,
        callId,
        fromUserId: principal.userId,
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.ice.restart failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'ICE restart relay failed', 'ERROR'))
    }
  })

  // call.sync — client requests current participant snapshot after reconnect
  socket.on('call.sync', async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) {
      return safeAck(ack, err('conversationId and callId required', 'BAD_REQUEST'))
    }
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      const participants = await deps.callsService?.getParticipantsSnapshot?.(conversationId, callId) ?? []
      socket.emit('call.participants.snapshot', { conversationId, callId, participants })
      safeAck(ack, ok({ participants }))
    } catch (error: any) {
      logger.error(`[calls] call.sync failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Sync failed', 'ERROR'))
    }
  })
}

// ─── Social call events (raise hand, reactions, in-call chat) ────────────────

function registerSocialHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  // call.hand.raise — participant raises hand (broadcast to conv)
  socket.on(EVT.CALL_HAND_RAISE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallHandDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:hand', 10)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_HAND_RAISE, {
        conversationId,
        callId,
        userId: principal.userId,
        raisedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.hand.raise failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Hand raise failed', 'ERROR'))
    }
  })

  // call.hand.lower — participant lowers hand (broadcast to conv)
  socket.on(EVT.CALL_HAND_LOWER, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallHandDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:hand', 10)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_HAND_LOWER, {
        conversationId,
        callId,
        userId: principal.userId,
        loweredAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.hand.lower failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Hand lower failed', 'ERROR'))
    }
  })

  // call.reaction — emoji reaction (broadcast to conv)
  socket.on(EVT.CALL_REACTION, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallReactionDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId, emoji } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:reaction', 30)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_REACTION, {
        conversationId,
        callId,
        userId: principal.userId,
        emoji,
        sentAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.reaction failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Reaction failed', 'ERROR'))
    }
  })

  // call.chat.message — in-call chat message (broadcast to conv)
  socket.on(EVT.CALL_CHAT_MSG, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallChatDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId, text } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:chat', 30)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_CHAT_MSG, {
        conversationId,
        callId,
        userId: principal.userId,
        text,
        sentAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.chat.message failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'In-call chat failed', 'ERROR'))
    }
  })
}

// ─── Host-only controls (mute participant, remove participant) ────────────────

function registerHostHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  // call.participant.mute — host mutes another participant
  socket.on(EVT.CALL_PARTICIPANT_MUTE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallParticipantActionDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId, targetUserId } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      // Verify the requester is the call creator (host)
      if (deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId)
        if (creator && creator !== principal.userId) {
          return safeAck(ack, err('Only the call host can mute participants', 'FORBIDDEN'))
        }
      }

      // Broadcast mute to entire conv room — each client enforces locally
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_PARTICIPANT_MUTED, {
        conversationId,
        callId,
        userId: targetUserId,
        mutedBy: principal.userId,
        mutedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.participant.mute failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Mute failed', 'ERROR'))
    }
  })

  // call.participant.remove — host removes a participant from the call
  socket.on(EVT.CALL_PARTICIPANT_REMOVE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const v = await validateSocketPayload(CallParticipantActionDto, payload)
    if (!v.ok) return safeAck(ack, err(v.errors.join('; '), 'BAD_REQUEST'))

    const { conversationId, callId, targetUserId } = v.value
    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      // Verify the requester is the call creator (host)
      if (deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId)
        if (creator && creator !== principal.userId) {
          return safeAck(ack, err('Only the call host can remove participants', 'FORBIDDEN'))
        }
      }

      const removedAt = new Date().toISOString()

      // Update DB: mark target as left with reason 'removed_by_host'
      await deps.callsService?.setParticipantStatus?.(
        conversationId,
        callId,
        targetUserId,
        'left',
        'removed_by_host',
      )

      // Targeted: send call.end only to the removed user's device(s)
      safeEmit(server, rooms.userRoom(targetUserId), EVT.CALL_END, {
        conversationId,
        callId,
        reason: 'removed_by_host',
        removedBy: principal.userId,
        endedAt: removedAt,
      })

      // Broadcast to conv: this participant left
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_PARTICIPANT_LEFT, {
        conversationId,
        callId,
        userId: targetUserId,
        reason: 'removed_by_host',
        leftAt: removedAt,
      })

      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.participant.remove failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Remove failed', 'ERROR'))
    }
  })
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerCallHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  // Legacy 1:1 call signaling
  socket.on(EVT.CALL_OFFER, createCallHandler(EVT.CALL_OFFER, server, socket, deps))
  socket.on(EVT.CALL_ANSWER, createCallHandler(EVT.CALL_ANSWER, server, socket, deps))
  socket.on(EVT.CALL_ICE, createCallHandler(EVT.CALL_ICE, server, socket, deps))
  socket.on(EVT.CALL_END, createCallHandler(EVT.CALL_END, server, socket, deps))

  // WebRTC peer-to-peer media negotiation
  registerWebRTCHandlers(server, socket, deps)

  // Social in-call events
  registerSocialHandlers(server, socket, deps)

  // Host moderation controls
  registerHostHandlers(server, socket, deps)
}
