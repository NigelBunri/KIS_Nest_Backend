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

  getOrCreatePeer(callId: string, userId: string): SfuPeerState {
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
    const transport = await this.router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS)
    this.transports.set(transport.id, transport)

    const peer = this.getOrCreatePeer(callId, userId)
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

  async connectTransport(transportId: string, dtlsParameters: any): Promise<void> {
    const transport = this.transports.get(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)
    await transport.connect({ dtlsParameters })
  }

  private closeTransport(transportId: string) {
    const transport = this.transports.get(transportId)
    if (!transport) return
    try { transport.close() } catch {}
    this.transports.delete(transportId)
  }

  // ── Producer lifecycle ──────────────────────────────────────────────────────

  async produce(callId: string, userId: string, transportId: string, kind: string, rtpParameters: any): Promise<any> {
    const transport = this.transports.get(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)

    const producer = await transport.produce({ kind, rtpParameters })
    this.producers.set(producer.id, producer)

    const peer = this.getOrCreatePeer(callId, userId)
    peer.producers.set(producer.id, kind as 'audio' | 'video')

    producer.on('transportclose', () => { this.producers.delete(producer.id) })

    return { id: producer.id }
  }

  async closeProducer(callId: string, userId: string, producerId: string): Promise<void> {
    const producer = this.producers.get(producerId)
    if (producer) { try { producer.close() } catch {} this.producers.delete(producerId) }
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
    const transport = this.transports.get(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)
    const producer = this.producers.get(producerId)
    if (!producer) throw new Error(`Producer ${producerId} not found`)
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cannot consume — incompatible RTP capabilities')
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // client must resume
    })
    this.consumers.set(consumer.id, consumer)

    const peer = this.getOrCreatePeer(callId, consumingUserId)
    peer.consumers.set(consumer.id, producerId)

    consumer.on('transportclose', () => { this.consumers.delete(consumer.id) })
    consumer.on('producerclose', () => { this.consumers.delete(consumer.id) })

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused,
    }
  }

  async resumeConsumer(consumerId: string): Promise<void> {
    const consumer = this.consumers.get(consumerId)
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`)
    await consumer.resume()
  }
}
