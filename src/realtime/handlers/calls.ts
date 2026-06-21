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
  notificationsService?: {
    notifyIncomingCall(input: {
      toUserId: string
      fromUserId: string
      fromDisplayName?: string
      conversationId: string
      callId: string
      callType?: string
      title?: string
    }): Promise<any>
    notifyMissedCall(input: {
      toUserId: string
      fromUserId: string
      fromDisplayName?: string
      conversationId: string
      callId: string
      callType?: string
    }): Promise<any>
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
    addKnocker?(conversationId: string, callId: string, userId: string): Promise<void>
    removeKnocker?(conversationId: string, callId: string, userId: string): Promise<void>
    getCall?(conversationId: string, callId: string): Promise<any>
    setRecordingState?(conversationId: string, callId: string, state: 'idle' | 'recording' | 'stopped', url?: string): Promise<void>
    setRtmp?(conversationId: string, callId: string, active: boolean, url?: string): Promise<void>
    getWaitingParticipants?(conversationId: string, callId: string): Promise<string[]>
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
          const callToJoin = await deps.callsService.ensureCallExistsOrThrow?.(conversationId, callId)
          // Enforce participant caps. Broadcast is viewer-counted separately.
          const MAX_PARTICIPANTS: Record<string, number> = {
            voice: 2, video: 2, 'voice-group': 100, 'video-group': 32, broadcast: 1000,
          }
          const cap = MAX_PARTICIPANTS[callToJoin?.callType ?? 'voice'] ?? 2
          const currentJoined = (callToJoin?.participants ?? []).filter(
            (p: any) => p.status === 'joined' || p.status === 'connecting',
          ).length
          if (currentJoined >= cap) {
            return safeAck(ack, err(`Call is full (max ${cap} participants)`, 'CALL_FULL'))
          }
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
        const callType = typeof payload?.callType === 'string' ? payload.callType : 'voice'
        const callTitle = typeof payload?.title === 'string' ? payload.title : undefined
        for (const uid of offerInviteeIds) {
          safeEmit(server, rooms.userRoom(uid), EVT.CALL_OFFER, enrichedPayload)
          server.in(rooms.userRoom(uid)).socketsJoin(rooms.convRoom(conversationId))
          // Fire-and-forget push notification so offline/backgrounded recipients are woken up.
          if (deps.notificationsService && callId) {
            deps.notificationsService.notifyIncomingCall({
              toUserId: uid,
              fromUserId: principal.userId,
              fromDisplayName: principal.username,
              conversationId,
              callId,
              callType,
              title: callTitle,
            }).catch((e: any) => logger.warn(`[calls] push notify failed userId=${uid}`, e?.message))
          }
        }
        // Also ensure the caller's sockets are in the conv room
        server.in(rooms.userRoom(principal.userId)).socketsJoin(rooms.convRoom(conversationId))
      }

      // call.end with rejected/busy/no_answer: notify invitees they missed the call
      if (event === EVT.CALL_END && deps.notificationsService) {
        const reason = typeof payload?.reason === 'string' ? payload.reason : ''
        if (['rejected', 'busy', 'no_answer', 'missed', 'cancelled'].includes(reason) && callId) {
          const missedCall = await deps.callsService?.getCall?.(conversationId, callId).catch(() => null)
          if (missedCall) {
            const unanswered = missedCall.participants.filter(
              (p: any) => p.userId !== principal.userId && (p.status === 'invited' || p.status === 'connecting'),
            )
            for (const p of unanswered) {
              deps.notificationsService.notifyMissedCall({
                toUserId: p.userId,
                fromUserId: missedCall.createdBy,
                conversationId,
                callId,
                callType: missedCall.callType,
              }).catch(() => {})
            }
          }
        }
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

// ─── Screen sharing ───────────────────────────────────────────────────────────

function registerScreenShareHandler(server: Server, socket: Socket, deps: CallsDeps) {
  // call.screen_share — participant starts/stops sharing their screen
  socket.on(EVT.CALL_SCREEN_SHARE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const enabled = typeof p.enabled === 'boolean' ? p.enabled : null
    const sdp = p.sdp ?? undefined

    if (!conversationId || enabled === null) {
      return safeAck(ack, err('conversationId and enabled are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService?.assert(principal, 'call:screen_share', 20)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      // Broadcast to all other call participants in the conversation room
      const broadcastPayload: Record<string, unknown> = {
        conversationId,
        userId: principal.userId,
        enabled,
        at: new Date().toISOString(),
      }
      if (sdp !== undefined) broadcastPayload.sdp = sdp

      // Emit to the conv room; the sender's own socket is excluded automatically
      // by broadcasting to server.to(room) rather than socket.broadcast.to(room)
      // so all participants (including other devices of the same user) receive it.
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_SCREEN_SHARE, broadcastPayload)
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.screen_share failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Screen share failed', 'ERROR'))
    }
  })
}

// ─── call.leave — participant exits without ending the session ────────────────
// This is separate from call.end: call.leave only removes the sender from the
// participant list. Everyone else stays in the call. The session auto-ends only
// when the last participant has left (endIfNoActiveParticipants).

function registerLeaveHandler(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on(EVT.CALL_LEAVE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId          = typeof p.callId === 'string'          ? p.callId          : null

    if (!conversationId || !callId) {
      return safeAck(ack, err('conversationId and callId required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService?.assert(principal, 'call:leave', 30)

      const leftAt = new Date().toISOString()

      // Mark this participant as left (non-terminal — other participants stay)
      await deps.callsService?.setParticipantStatus?.(
        conversationId, callId, principal.userId, 'left', 'left',
      )

      // Log the hangup signal for audit
      await deps.callsService?.appendSignal?.(conversationId, callId, {
        kind: 'hangup',
        fromUserId: principal.userId,
        payloadType: 'left',
      })

      // Decrement broadcast viewer count if this was an audience member
      const existingCall = await deps.callsService?.getCall?.(conversationId, callId)
      if (
        existingCall?.callType === 'broadcast' &&
        existingCall?.createdBy !== principal.userId &&
        deps.callsService?.bumpViewerCount
      ) {
        const count = await deps.callsService.bumpViewerCount(conversationId, callId, -1)
        safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_VIEWER_COUNT, {
          callId, conversationId, viewerCount: count,
        })
      }

      // Tell all other participants in the room that this person left.
      // This is what removes their tile from the grid on other devices.
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_PARTICIPANT_LEFT, {
        conversationId, callId, userId: principal.userId, reason: 'left', leftAt,
      })

      // Auto-end the session only when nobody is left.
      await deps.callsService?.endIfNoActiveParticipants?.(conversationId, callId)

      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.leave failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Leave failed', 'ERROR'))
    }
  })
}

// ─── Knock / Admit / Deny / Promote ──────────────────────────────────────────

function registerKnockHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  // call.knock — participant asks to join (broadcast or locked call)
  socket.on(EVT.CALL_KNOCK, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const displayName = typeof p.displayName === 'string' ? p.displayName : principal.userId

    if (!conversationId || !callId) {
      return safeAck(ack, err('conversationId and callId required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService?.assert(principal, 'call:knock', 5)
      await deps.callsService?.addKnocker?.(conversationId, callId, principal.userId)

      // Broadcast knock request to all conv participants so the host sees it
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_KNOCK_REQUEST, {
        conversationId,
        callId,
        userId: principal.userId,
        displayName,
        knockedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.knock failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Knock failed', 'ERROR'))
    }
  })

  // call.knock.admit — host admits a knocking participant
  socket.on(EVT.CALL_KNOCK_ADMIT, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const targetUserId = typeof p.targetUserId === 'string' ? p.targetUserId : null

    if (!conversationId || !callId || !targetUserId) {
      return safeAck(ack, err('conversationId, callId, targetUserId required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      if (deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId)
        if (creator && creator !== principal.userId) {
          return safeAck(ack, err('Only the call host can admit participants', 'FORBIDDEN'))
        }
      }

      await deps.callsService?.removeKnocker?.(conversationId, callId, targetUserId)
      await deps.callsService?.setParticipantStatus?.(conversationId, callId, targetUserId, 'invited')

      // Tell the knocking user they have been admitted
      safeEmit(server, rooms.userRoom(targetUserId), EVT.CALL_KNOCK_ADMITTED, {
        conversationId,
        callId,
        admittedBy: principal.userId,
        admittedAt: new Date().toISOString(),
      })
      // Also pull their sockets into the conv room
      server.in(rooms.userRoom(targetUserId)).socketsJoin(rooms.convRoom(conversationId))

      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.knock.admit failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Admit failed', 'ERROR'))
    }
  })

  // call.knock.deny — host rejects a knocking participant
  socket.on(EVT.CALL_KNOCK_DENY, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const targetUserId = typeof p.targetUserId === 'string' ? p.targetUserId : null

    if (!conversationId || !callId || !targetUserId) {
      return safeAck(ack, err('conversationId, callId, targetUserId required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      if (deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId)
        if (creator && creator !== principal.userId) {
          return safeAck(ack, err('Only the call host can deny participants', 'FORBIDDEN'))
        }
      }

      await deps.callsService?.removeKnocker?.(conversationId, callId, targetUserId)

      // Tell the knocking user they were denied
      safeEmit(server, rooms.userRoom(targetUserId), EVT.CALL_KNOCK_DENIED, {
        conversationId,
        callId,
        deniedBy: principal.userId,
        deniedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.knock.deny failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Deny failed', 'ERROR'))
    }
  })

  // call.promote — host changes another participant's role
  socket.on(EVT.CALL_PROMOTE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const targetUserId = typeof p.targetUserId === 'string' ? p.targetUserId : null
    const role = typeof p.role === 'string' ? p.role : null

    if (!conversationId || !callId || !targetUserId || !role) {
      return safeAck(ack, err('conversationId, callId, targetUserId, role required', 'BAD_REQUEST'))
    }

    const VALID_ROLES = ['host', 'co-host', 'speaker', 'audience']
    if (!VALID_ROLES.includes(role)) {
      return safeAck(ack, err(`role must be one of: ${VALID_ROLES.join(', ')}`, 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      if (deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId)
        if (creator && creator !== principal.userId) {
          return safeAck(ack, err('Only the call host can change roles', 'FORBIDDEN'))
        }
      }

      await deps.callsService?.setParticipantRole?.(
        conversationId,
        callId,
        targetUserId,
        role as any,
      )

      // Broadcast role change to all participants
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_ROLE_CHANGED, {
        conversationId,
        callId,
        userId: targetUserId,
        role,
        changedBy: principal.userId,
        changedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (error: any) {
      logger.error(`[calls] call.promote failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Promote failed', 'ERROR'))
    }
  })
}

// ─── Recording ───────────────────────────────────────────────────────────────

function registerRecordingHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  const hostOnly = async (conversationId: string, callId: string, principal: SocketPrincipal): Promise<boolean> => {
    if (deps.callsService?.getCallCreator) {
      const creator = await deps.callsService.getCallCreator(conversationId, callId)
      if (creator && creator !== principal.userId) return false
    }
    return true
  }

  socket.on(EVT.CALL_RECORDING_START, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return safeAck(ack, err('conversationId and callId required', 'BAD_REQUEST'))
    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      if (!(await hostOnly(conversationId, callId, principal))) return safeAck(ack, err('Host only', 'FORBIDDEN'))
      await deps.callsService?.setRecordingState?.(conversationId, callId, 'recording')
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_RECORDING_CHANGED, {
        conversationId, callId, recordingState: 'recording', changedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  socket.on(EVT.CALL_RECORDING_STOP, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return safeAck(ack, err('conversationId and callId required', 'BAD_REQUEST'))
    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      if (!(await hostOnly(conversationId, callId, principal))) return safeAck(ack, err('Host only', 'FORBIDDEN'))
      await deps.callsService?.setRecordingState?.(conversationId, callId, 'stopped')
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_RECORDING_CHANGED, {
        conversationId, callId, recordingState: 'stopped', changedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })
}

// ─── Live captions relay ──────────────────────────────────────────────────────

function registerCaptionHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on(EVT.CALL_CAPTION, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const text = typeof p.text === 'string' ? p.text.slice(0, 500) : null
    if (!conversationId || !callId || !text) return safeAck(ack, err('conversationId, callId and text required', 'BAD_REQUEST'))
    try {
      await deps.rateLimitService?.assert(principal, 'call:caption', 120)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_CAPTION, {
        conversationId, callId, userId: principal.userId, text, sentAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })
}

// ─── Join-before-host ─────────────────────────────────────────────────────────
// When a participant joins a pending/scheduled call, they wait.
// When the host emits call.offer, the server notifies all waiting participants.

function registerJoinBeforeHostHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on('call.waiting.join', async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return safeAck(ack, err('conversationId and callId required', 'BAD_REQUEST'))
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      // Record that this user is waiting
      await deps.callsService?.setParticipantStatus?.(conversationId, callId, principal.userId, 'invited')
      // Pull socket into conv room so they receive call.offer when the host starts
      socket.join(rooms.convRoom(conversationId))
      safeAck(ack, ok({ waiting: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })
}

// ─── In-call polls ────────────────────────────────────────────────────────────

function registerPollHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on(EVT.CALL_POLL_CREATE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const question = typeof p.question === 'string' ? p.question.slice(0, 200) : null
    const options = Array.isArray(p.options) ? (p.options as any[]).slice(0, 6).map(String) : null
    if (!conversationId || !callId || !question || !options?.length) {
      return safeAck(ack, err('conversationId, callId, question, options required', 'BAD_REQUEST'))
    }
    try {
      await deps.rateLimitService?.assert(principal, 'call:poll', 10)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      const pollId = `poll_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const poll = {
        pollId, conversationId, callId, question, options,
        votes: {} as Record<string, string>,
        createdBy: principal.userId, createdAt: new Date().toISOString(), closed: false,
      }
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_POLL_CREATE, poll)
      safeAck(ack, ok({ pollId }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  socket.on(EVT.CALL_POLL_VOTE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const pollId = typeof p.pollId === 'string' ? p.pollId : null
    const option = typeof p.option === 'string' ? p.option : null
    if (!conversationId || !callId || !pollId || !option) {
      return safeAck(ack, err('conversationId, callId, pollId, option required', 'BAD_REQUEST'))
    }
    try {
      await deps.rateLimitService?.assert(principal, 'call:poll:vote', 30)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_POLL_VOTE, {
        conversationId, callId, pollId, userId: principal.userId, option, votedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  socket.on(EVT.CALL_POLL_CLOSE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const pollId = typeof p.pollId === 'string' ? p.pollId : null
    if (!conversationId || !callId || !pollId) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_POLL_CLOSE, {
        conversationId, callId, pollId, closedBy: principal.userId, closedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })
}

// ─── Q&A mode ─────────────────────────────────────────────────────────────────

function registerQAHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on(EVT.CALL_QUESTION_SUBMIT, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const text = typeof p.text === 'string' ? p.text.slice(0, 300) : null
    const anonymous = p.anonymous === true
    if (!conversationId || !callId || !text) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.rateLimitService?.assert(principal, 'call:qa', 10)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_QA_UPDATED, {
        conversationId, callId, action: 'add',
        question: {
          questionId, text,
          userId: anonymous ? null : principal.userId,
          displayName: anonymous ? 'Anonymous' : principal.username,
          submittedAt: new Date().toISOString(), answered: false,
        },
      })
      safeAck(ack, ok({ questionId }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  for (const evt of [EVT.CALL_QUESTION_DISMISS, EVT.CALL_QUESTION_ANSWERED]) {
    socket.on(evt, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
      const principal = getPrincipal(socket)
      const p = payload as Record<string, unknown> ?? {}
      const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
      const callId = typeof p.callId === 'string' ? p.callId : null
      const questionId = typeof p.questionId === 'string' ? p.questionId : null
      if (!conversationId || !callId || !questionId) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
      try {
        await deps.djangoConversationClient.assertMember(principal, conversationId)
        safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_QA_UPDATED, {
          conversationId, callId,
          action: evt === EVT.CALL_QUESTION_ANSWERED ? 'answered' : 'dismiss',
          question: { questionId },
        })
        safeAck(ack, ok({ delivered: true }))
      } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
    })
  }
}

// ─── Breakout rooms ───────────────────────────────────────────────────────────

function registerBreakoutHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on(EVT.CALL_BREAKOUT_CREATE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const rooms_ = Array.isArray(p.rooms) ? p.rooms as { name: string; userIds: string[] }[] : null
    if (!conversationId || !callId || !rooms_?.length) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      if (deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId)
        if (creator && creator !== principal.userId) return safeAck(ack, err('Host only', 'FORBIDDEN'))
      }
      const breakoutRooms = rooms_.map((r, i) => ({
        roomId: `${callId}_br_${i + 1}`,
        name: r.name || `Room ${i + 1}`,
        userIds: r.userIds,
      }))
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_BREAKOUT_UPDATED, {
        conversationId, callId, action: 'created', breakoutRooms, createdAt: new Date().toISOString(),
      })
      // Tell each assigned participant which breakout room they're in
      for (const room_ of breakoutRooms) {
        for (const uid of room_.userIds) {
          safeEmit(server, rooms.userRoom(uid), EVT.CALL_BREAKOUT_ASSIGN, {
            conversationId, callId, roomId: room_.roomId, roomName: room_.name,
          })
        }
      }
      safeAck(ack, ok({ breakoutRooms }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  socket.on(EVT.CALL_BREAKOUT_RETURN, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_BREAKOUT_RETURN, {
        conversationId, callId, userId: principal.userId, returnedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  socket.on(EVT.CALL_BREAKOUT_CLOSE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_BREAKOUT_UPDATED, {
        conversationId, callId, action: 'closed', closedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })
}

// ─── RTMP streaming ───────────────────────────────────────────────────────────

function registerRtmpHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  socket.on(EVT.CALL_RTMP_START, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const rtmpUrl = typeof p.rtmpUrl === 'string' ? p.rtmpUrl : null
    if (!conversationId || !callId || !rtmpUrl) return safeAck(ack, err('conversationId, callId, rtmpUrl required', 'BAD_REQUEST'))
    try {
      await deps.rateLimitService?.assert(principal, 'call:host', 60)
      if (deps.callsService?.getCallCreator) {
        const creator = await deps.callsService.getCallCreator(conversationId, callId)
        if (creator && creator !== principal.userId) return safeAck(ack, err('Host only', 'FORBIDDEN'))
      }
      await deps.callsService?.setRtmp?.(conversationId, callId, true, rtmpUrl)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_RTMP_CHANGED, {
        conversationId, callId, rtmpActive: true, rtmpUrl, changedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  socket.on(EVT.CALL_RTMP_STOP, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      await deps.callsService?.setRtmp?.(conversationId, callId, false)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_RTMP_CHANGED, {
        conversationId, callId, rtmpActive: false, changedAt: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })
}

// ─── Whiteboard ───────────────────────────────────────────────────────────────

function registerWhiteboardHandlers(server: Server, socket: Socket, deps: CallsDeps) {
  // Relay a drawn stroke to all participants
  socket.on(EVT.CALL_WB_STROKE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const stroke = p.stroke ?? null
    if (!conversationId || !callId || !stroke) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.rateLimitService?.assert(principal, 'call:wb:stroke', 300)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_WB_STROKE, {
        conversationId, callId, userId: principal.userId, stroke, at: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  // Clear the whiteboard (host only)
  socket.on(EVT.CALL_WB_CLEAR, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_WB_CLEAR, {
        conversationId, callId, clearedBy: principal.userId, at: new Date().toISOString(),
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  // Undo last stroke (sent by the user who drew it)
  socket.on(EVT.CALL_WB_UNDO, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    const strokeId = typeof p.strokeId === 'string' ? p.strokeId : null
    if (!conversationId || !callId || !strokeId) return safeAck(ack, err('required fields missing', 'BAD_REQUEST'))
    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_WB_UNDO, {
        conversationId, callId, strokeId, userId: principal.userId,
      })
      safeAck(ack, ok({ delivered: true }))
    } catch (e: any) { safeAck(ack, err(e?.message ?? 'Error', 'ERROR')) }
  })

  // Cursor position relay (best-effort, no ACK needed)
  socket.on(EVT.CALL_WB_CURSOR, async (payload: unknown) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const callId = typeof p.callId === 'string' ? p.callId : null
    if (!conversationId || !callId) return
    safeEmit(server, rooms.convRoom(conversationId), EVT.CALL_WB_CURSOR, {
      conversationId, callId, userId: principal.userId, x: p.x, y: p.y,
    })
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

  // Screen sharing
  registerScreenShareHandler(server, socket, deps)

  // Participant leave (without ending the session for others)
  registerLeaveHandler(server, socket, deps)

  // Knock / admit / deny / promote
  registerKnockHandlers(server, socket, deps)

  // Recording
  registerRecordingHandlers(server, socket, deps)

  // Live captions relay
  registerCaptionHandlers(server, socket, deps)

  // Join before host
  registerJoinBeforeHostHandlers(server, socket, deps)

  // In-call polls
  registerPollHandlers(server, socket, deps)

  // Q&A mode
  registerQAHandlers(server, socket, deps)

  // Breakout rooms
  registerBreakoutHandlers(server, socket, deps)

  // RTMP streaming
  registerRtmpHandlers(server, socket, deps)

  // Whiteboard
  registerWhiteboardHandlers(server, socket, deps)
}
