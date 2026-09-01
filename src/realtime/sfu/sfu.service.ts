// src/realtime/sfu/sfu.service.ts
//
// Mediasoup SFU service.
//
// Install:  npm install mediasoup
// The mediasoup package includes native C++ bindings. After npm install run:
//   cd ios && pod install   (iOS)
//   (Android — nothing extra needed for the NestJS backend)
//
// Without mediasoup installed, the service initialises in stub mode and all
// SFU calls fall through to the existing P2P mesh path.

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import type { SfuRoomState, SfuPeerState, SfuTransportDir } from './sfu.types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mediasoup: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mediasoup = require('mediasoup')
} catch {
  // mediasoup binary not available — all methods return stub responses
}

// Mediasoup codecs we want to support
const MEDIA_CODECS: any[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: { 'sprop-stereo': 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {},
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
]

const WEBRTC_TRANSPORT_OPTIONS: any = {
  listenIps: [
    {
      ip: process.env.MEDIASOUP_LISTEN_IP ?? '0.0.0.0',
      announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP ?? null,
    },
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1_000_000,
}

@Injectable()
export class SfuService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SfuService.name)
  private worker: any = null      // mediasoup.types.Worker
  private router: any = null      // mediasoup.types.Router (single global router for simplicity)
  private rooms = new Map<string, SfuRoomState>()
  // transport / producer / consumer registries
  private transports = new Map<string, any>()
  private producers = new Map<string, any>()
  private consumers = new Map<string, any>()
  // Ownership of transports/producers, keyed by their own id -> {callId, userId}.
  // Every mutating call below checks this before touching mediasoup state, so
  // a transportId/producerId leaking or being guessed doesn't let another
  // user (even one legitimately in some OTHER call) act on it.
  private transportOwners = new Map<string, { callId: string; userId: string }>()
  private producerOwners = new Map<string, { callId: string; userId: string }>()
  private consumerOwners = new Map<string, { userId: string }>()

  get available(): boolean { return !!mediasoup && !!this.router }

  async onModuleInit() {
    if (!mediasoup) {
      this.logger.warn('[SFU] mediasoup not installed — running in P2P-only mode. Run: npm install mediasoup')
      return
    }
    try {
      this.worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000),
        rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 49999),
      })
      this.worker.on('died', () => {
        this.logger.error('[SFU] mediasoup worker died — restarting in 1 s')
        setTimeout(() => this.onModuleInit(), 1000)
      })
      this.router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS })
      this.logger.log('[SFU] mediasoup worker + router ready')
    } catch (e: any) {
      this.logger.error('[SFU] init failed', e?.message)
    }
  }

  onModuleDestroy() {
    try { this.worker?.close() } catch {}
  }

  /** RTP capabilities of the router — clients load these into their Device. */
  getRtpCapabilities(): any {
    return this.router?.rtpCapabilities ?? null
  }

  // ── Room management ─────────────────────────────────────────────────────────

  getOrCreateRoom(callId: string): SfuRoomState {
    let room = this.rooms.get(callId)
    if (!room) {
      room = { callId, peers: new Map() }
      this.rooms.set(callId, room)
    }
    return room
  }

  /**
   * Creates (or returns the existing) peer state for callId+userId. This is
   * the ONLY entry point that should be called without first checking
   * getAuthorizedPeer - callers must have already verified the user is a
   * genuine participant of this specific call (see sfu.ts's SFU_JOIN
   * handler, which checks CallSession.participants before calling this).
   */
  authorizePeer(callId: string, userId: string): SfuPeerState {
    const room = this.getOrCreateRoom(callId)
    let peer = room.peers.get(userId)
    if (!peer) {
      peer = {
        userId,
        sendTransportId: null,
        recvTransportId: null,
        producers: new Map(),
        consumers: new Map(),
      }
      room.peers.set(userId, peer)
    }
    return peer
  }

  /**
   * Returns the peer for callId+userId only if they already completed a
   * verified SFU_JOIN for THIS call - never creates one. Every handler that
   * isn't SFU_JOIN itself must go through this (or an ownership check keyed
   * off transportOwners/producerOwners) instead of silently vivifying state
   * for whatever callId a client happens to send.
   */
  getAuthorizedPeer(callId: string, userId: string): SfuPeerState | null {
    return this.rooms.get(callId)?.peers.get(userId) ?? null
  }

  removePeer(callId: string, userId: string) {
    const room = this.rooms.get(callId)
    if (!room) return
    const peer = room.peers.get(userId)
    if (!peer) return

    // Close all transports
    if (peer.sendTransportId) this.closeTransport(peer.sendTransportId)
    if (peer.recvTransportId) this.closeTransport(peer.recvTransportId)
    room.peers.delete(userId)

    // Cleanup empty rooms
    if (room.peers.size === 0) this.rooms.delete(callId)
  }

  getProducersForRoom(callId: string, excludeUserId?: string): { producerId: string; userId: string; kind: string }[] {
    const room = this.rooms.get(callId)
    if (!room) return []
    const result: { producerId: string; userId: string; kind: string }[] = []
    for (const [userId, peer] of room.peers) {
      if (userId === excludeUserId) continue
      for (const [producerId, kind] of peer.producers) {
        result.push({ producerId, userId, kind })
      }
    }
    return result
  }

  // ── Transport lifecycle ─────────────────────────────────────────────────────

  async createWebRtcTransport(callId: string, userId: string, direction: SfuTransportDir): Promise<any> {
    if (!this.router) throw new Error('SFU not available')
    const peer = this.getAuthorizedPeer(callId, userId)
    if (!peer) throw new Error('Not an authorized participant of this call')

    const transport = await this.router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS)
    this.transports.set(transport.id, transport)
    this.transportOwners.set(transport.id, { callId, userId })

    if (direction === 'send') peer.sendTransportId = transport.id
    else peer.recvTransportId = transport.id

    transport.on('dtlsstatechange', (state: string) => {
      if (state === 'closed') this.closeTransport(transport.id)
    })

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    }
  }

  async connectTransport(transportId: string, userId: string, dtlsParameters: any): Promise<void> {
    const transport = this.transports.get(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)
    const owner = this.transportOwners.get(transportId)
    if (!owner || owner.userId !== userId) throw new Error('Not the owner of this transport')
    await transport.connect({ dtlsParameters })
  }

  private closeTransport(transportId: string) {
    const transport = this.transports.get(transportId)
    if (!transport) return
    try { transport.close() } catch {}
    this.transports.delete(transportId)
    this.transportOwners.delete(transportId)
  }

  // ── Producer lifecycle ──────────────────────────────────────────────────────

  async produce(callId: string, userId: string, transportId: string, kind: string, rtpParameters: any): Promise<any> {
    const peer = this.getAuthorizedPeer(callId, userId)
    if (!peer) throw new Error('Not an authorized participant of this call')
    const transport = this.transports.get(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)
    const transportOwner = this.transportOwners.get(transportId)
    if (!transportOwner || transportOwner.userId !== userId || transportOwner.callId !== callId) {
      throw new Error('Not the owner of this transport')
    }

    const producer = await transport.produce({ kind, rtpParameters })
    this.producers.set(producer.id, producer)
    this.producerOwners.set(producer.id, { callId, userId })

    peer.producers.set(producer.id, kind as 'audio' | 'video')

    producer.on('transportclose', () => {
      this.producers.delete(producer.id)
      this.producerOwners.delete(producer.id)
    })

    return { id: producer.id }
  }

  async closeProducer(callId: string, userId: string, producerId: string): Promise<void> {
    const owner = this.producerOwners.get(producerId)
    if (!owner || owner.userId !== userId || owner.callId !== callId) {
      throw new Error('Not the owner of this producer')
    }
    const producer = this.producers.get(producerId)
    if (producer) { try { producer.close() } catch {} this.producers.delete(producerId) }
    this.producerOwners.delete(producerId)
    const room = this.rooms.get(callId)
    room?.peers.get(userId)?.producers.delete(producerId)
  }

  // ── Consumer lifecycle ──────────────────────────────────────────────────────

  async consume(
    callId: string,
    consumingUserId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: any,
  ): Promise<any> {
    const peer = this.getAuthorizedPeer(callId, consumingUserId)
    if (!peer) throw new Error('Not an authorized participant of this call')
    const transport = this.transports.get(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)
    const transportOwner = this.transportOwners.get(transportId)
    if (!transportOwner || transportOwner.userId !== consumingUserId || transportOwner.callId !== callId) {
      throw new Error('Not the owner of this transport')
    }
    const producer = this.producers.get(producerId)
    if (!producer) throw new Error(`Producer ${producerId} not found`)
    // The producer must belong to THIS SAME call - without this, a leaked or
    // guessed producerId from an unrelated call would let an attacker
    // consume that call's media despite being a legitimate peer elsewhere.
    const producerOwner = this.producerOwners.get(producerId)
    if (!producerOwner || producerOwner.callId !== callId) {
      throw new Error('Producer does not belong to this call')
    }
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cannot consume — incompatible RTP capabilities')
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // client must resume
    })
    this.consumers.set(consumer.id, consumer)
    this.consumerOwners.set(consumer.id, { userId: consumingUserId })

    peer.consumers.set(consumer.id, producerId)

    consumer.on('transportclose', () => {
      this.consumers.delete(consumer.id)
      this.consumerOwners.delete(consumer.id)
    })
    consumer.on('producerclose', () => {
      this.consumers.delete(consumer.id)
      this.consumerOwners.delete(consumer.id)
    })

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused,
    }
  }

  async resumeConsumer(consumerId: string, userId: string): Promise<void> {
    const consumer = this.consumers.get(consumerId)
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`)
    const owner = this.consumerOwners.get(consumerId)
    if (!owner || owner.userId !== userId) throw new Error('Not the owner of this consumer')
    await consumer.resume()
  }
}
