// src/realtime/handlers/sfu.ts
// Socket handlers for the Mediasoup SFU signalling plane.
//
// Socket contract (client emits → server handles):
//   sfu.join                  { callId, conversationId, rtpCapabilities }
//   sfu.transport.create      { callId, direction: 'send'|'recv' }
//   sfu.transport.connect     { transportId, dtlsParameters }
//   sfu.produce               { callId, transportId, kind, rtpParameters }
//   sfu.producer.close        { callId, producerId }
//   sfu.consume               { callId, transportId, producerId, rtpCapabilities }
//   sfu.consumer.resume       { consumerId }
//
// Server pushes to conv room:
//   sfu.producer.new          { callId, userId, producerId, kind }
//   sfu.producer.closed       { callId, userId, producerId }
//   sfu.peer.joined           { callId, userId }
//   sfu.peer.left             { callId, userId }

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'
import { EVT, rooms } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'
import type { SfuService } from '../sfu/sfu.service'
import type { RoomsDeps } from './rooms'
import type { Ack } from '../../chat/chat.types'

const logger = new Logger('SfuHandlers')

export interface SfuDeps {
  sfuService: SfuService
  djangoConversationClient: RoomsDeps['djangoConversationClient']
  rateLimitService?: { assert(p: any, key: string, limit?: number): Promise<void> | void }
}

export function registerSfuHandlers(server: Server, socket: Socket, deps: SfuDeps) {
  const { sfuService, djangoConversationClient, rateLimitService } = deps

  // ── Join SFU room ──────────────────────────────────────────────────────────
  // Returns the router RTP capabilities. The client loads these into its Device.
  // Also returns the list of existing producers so the client can start consuming.
  socket.on(EVT.SFU_JOIN, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const callId = typeof p.callId === 'string' ? p.callId : null
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    if (!callId || !conversationId) return safeAck(ack, err('callId and conversationId required', 'BAD_REQUEST'))

    try {
      await rateLimitService?.assert(principal, 'sfu:join', 10)
      await djangoConversationClient.assertMember(principal, conversationId)

      if (!sfuService.available) {
        return safeAck(ack, err('SFU not available — install mediasoup on the server', 'SFU_UNAVAILABLE'))
      }

      sfuService.getOrCreatePeer(callId, principal.userId)
      socket.join(rooms.convRoom(conversationId))

      const routerRtpCapabilities = sfuService.getRtpCapabilities()
      const existingProducers = sfuService.getProducersForRoom(callId, principal.userId)

      safeEmit(server, rooms.convRoom(conversationId), EVT.SFU_PEER_JOINED, {
        callId, userId: principal.userId, joinedAt: new Date().toISOString(),
      })

      safeAck(ack, ok({ routerRtpCapabilities, existingProducers }))
    } catch (e: any) {
      logger.error(`[sfu] sfu.join failed userId=${principal?.userId}`, e?.message)
      safeAck(ack, err(e?.message ?? 'Error', 'ERROR'))
    }
  })

  // ── Create WebRTC transport ────────────────────────────────────────────────
  socket.on(EVT.SFU_TRANSPORT_CREATE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const callId = typeof p.callId === 'string' ? p.callId : null
    const direction = p.direction === 'send' || p.direction === 'recv' ? p.direction : null
    if (!callId || !direction) return safeAck(ack, err('callId and direction required', 'BAD_REQUEST'))

    try {
      await rateLimitService?.assert(principal, 'sfu:transport', 20)
      if (!sfuService.available) return safeAck(ack, err('SFU not available', 'SFU_UNAVAILABLE'))

      const params = await sfuService.createWebRtcTransport(callId, principal.userId, direction)
      safeAck(ack, ok(params))
    } catch (e: any) {
      logger.error(`[sfu] sfu.transport.create failed`, e?.message)
      safeAck(ack, err(e?.message ?? 'Error', 'ERROR'))
    }
  })

  // ── Connect transport (DTLS handshake) ────────────────────────────────────
  socket.on(EVT.SFU_TRANSPORT_CONNECT, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const transportId = typeof p.transportId === 'string' ? p.transportId : null
    const dtlsParameters = p.dtlsParameters
    if (!transportId || !dtlsParameters) return safeAck(ack, err('transportId and dtlsParameters required', 'BAD_REQUEST'))

    try {
      await rateLimitService?.assert(principal, 'sfu:transport', 20)
      await sfuService.connectTransport(transportId, dtlsParameters)
      safeAck(ack, ok({ connected: true }))
    } catch (e: any) {
      logger.error(`[sfu] sfu.transport.connect failed`, e?.message)
      safeAck(ack, err(e?.message ?? 'Error', 'ERROR'))
    }
  })

  // ── Produce (local track → server) ────────────────────────────────────────
  socket.on(EVT.SFU_PRODUCE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const callId = typeof p.callId === 'string' ? p.callId : null
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const transportId = typeof p.transportId === 'string' ? p.transportId : null
    const kind = p.kind === 'audio' || p.kind === 'video' ? p.kind : null
    const rtpParameters = p.rtpParameters
    if (!callId || !transportId || !kind || !rtpParameters) {
      return safeAck(ack, err('callId, transportId, kind, rtpParameters required', 'BAD_REQUEST'))
    }

    try {
      await rateLimitService?.assert(principal, 'sfu:produce', 10)
      const { id: producerId } = await sfuService.produce(callId, principal.userId, transportId, kind, rtpParameters)

      // Notify all other participants in the room so they can start consuming
      safeEmit(server, rooms.convRoom(conversationId ?? callId), EVT.SFU_PRODUCER_NEW, {
        callId, userId: principal.userId, producerId, kind,
      })

      safeAck(ack, ok({ producerId }))
    } catch (e: any) {
      logger.error(`[sfu] sfu.produce failed`, e?.message)
      safeAck(ack, err(e?.message ?? 'Error', 'ERROR'))
    }
  })

  // ── Consume (subscribe to remote producer) ────────────────────────────────
  socket.on(EVT.SFU_CONSUME, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const callId = typeof p.callId === 'string' ? p.callId : null
    const transportId = typeof p.transportId === 'string' ? p.transportId : null
    const producerId = typeof p.producerId === 'string' ? p.producerId : null
    const rtpCapabilities = p.rtpCapabilities
    if (!callId || !transportId || !producerId || !rtpCapabilities) {
      return safeAck(ack, err('callId, transportId, producerId, rtpCapabilities required', 'BAD_REQUEST'))
    }

    try {
      await rateLimitService?.assert(principal, 'sfu:consume', 100)
      const params = await sfuService.consume(callId, principal.userId, transportId, producerId, rtpCapabilities)
      safeAck(ack, ok(params))
    } catch (e: any) {
      logger.error(`[sfu] sfu.consume failed`, e?.message)
      safeAck(ack, err(e?.message ?? 'Error', 'ERROR'))
    }
  })

  // ── Resume consumer ───────────────────────────────────────────────────────
  socket.on(EVT.SFU_CONSUMER_RESUME, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const consumerId = typeof p.consumerId === 'string' ? p.consumerId : null
    if (!consumerId) return safeAck(ack, err('consumerId required', 'BAD_REQUEST'))

    try {
      await sfuService.resumeConsumer(consumerId)
      safeAck(ack, ok({ resumed: true }))
    } catch (e: any) {
      logger.error(`[sfu] sfu.consumer.resume failed`, e?.message)
      safeAck(ack, err(e?.message ?? 'Error', 'ERROR'))
    }
  })

  // ── Close producer ────────────────────────────────────────────────────────
  socket.on('sfu.producer.close', async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const callId = typeof p.callId === 'string' ? p.callId : null
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId : null
    const producerId = typeof p.producerId === 'string' ? p.producerId : null
    if (!callId || !producerId) return safeAck(ack, err('callId and producerId required', 'BAD_REQUEST'))

    try {
      await sfuService.closeProducer(callId, principal.userId, producerId)
      safeEmit(server, rooms.convRoom(conversationId ?? callId), EVT.SFU_PRODUCER_CLOSED, {
        callId, userId: principal.userId, producerId,
      })
      safeAck(ack, ok({ closed: true }))
    } catch (e: any) {
      logger.error(`[sfu] sfu.producer.close failed`, e?.message)
      safeAck(ack, err(e?.message ?? 'Error', 'ERROR'))
    }
  })

  // ── Peer leaves (clean up SFU state) ─────────────────────────────────────
  // The main call lifecycle (call.leave / call.end) already handles the call
  // session. This handler cleans up SFU resources on socket disconnect.
  socket.on('disconnect', () => {
    // Identify which calls this user was participating in and clean up
    // We don't have the callId here, so we scan — this is fine at the scale
    // where SFU is used (if there are many rooms, use a socket.data cache).
    const userId = (socket as any)?.principal?.userId
    if (!userId) return
    // SfuService.rooms is private; expose a cleanup method
    ;(sfuService as any).rooms?.forEach((room: any, callId: string) => {
      if (room.peers.has(userId)) {
        sfuService.removePeer(callId, userId)
      }
    })
  })
}
