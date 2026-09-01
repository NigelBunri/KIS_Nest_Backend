// Authorization tests for SfuService — closes a critical bug where any
// authenticated socket could join, produce into, or consume from an
// arbitrary/guessed callId with zero verification, and cross-call producer
// IDs were consumable regardless of which call they actually belonged to.
// See handlers/sfu.ts's SFU_JOIN handler for the call-membership check that
// gates the one legitimate entry point (authorizePeer) into this state.
import { SfuService } from './sfu.service'

const CALL_A = 'call-a'
const CALL_B = 'call-b'
const USER_1 = 'user-1'
const USER_2 = 'user-2'

// mediasoup transport.produce() validates rtpParameters against the
// router's negotiated codecs, so a garbage payload won't do for tests that
// need a REAL producer to exist (the cross-call consume test). Minimal
// valid opus parameters, matching MEDIA_CODECS in sfu.service.ts.
const opusRtpParameters = {
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: 100,
      clockRate: 48000,
      channels: 2,
      parameters: { 'sprop-stereo': 1 },
    },
  ],
  encodings: [{ ssrc: 11111111 }],
}

describe('SfuService authorization', () => {
  let service: SfuService

  beforeEach(async () => {
    service = new SfuService()
    await service.onModuleInit()
  })

  afterEach(() => {
    service.onModuleDestroy()
  })

  it('is available with a real mediasoup router in this test environment', () => {
    expect(service.available).toBe(true)
  })

  describe('createWebRtcTransport', () => {
    it('rejects a caller who never completed an authorized SFU_JOIN for this call', async () => {
      await expect(
        service.createWebRtcTransport(CALL_A, USER_1, 'send'),
      ).rejects.toThrow('Not an authorized participant of this call')
    })

    it('succeeds once the peer has been authorized for that exact call', async () => {
      service.authorizePeer(CALL_A, USER_1)
      const transport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')
      expect(transport.id).toBeTruthy()
    })

    it('does not authorize a peer for a DIFFERENT call than the one they joined', async () => {
      service.authorizePeer(CALL_A, USER_1)
      await expect(
        service.createWebRtcTransport(CALL_B, USER_1, 'send'),
      ).rejects.toThrow('Not an authorized participant of this call')
    })
  })

  describe('connectTransport', () => {
    it('rejects a user who does not own the transport', async () => {
      service.authorizePeer(CALL_A, USER_1)
      const transport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')

      await expect(
        service.connectTransport(transport.id, USER_2, { fingerprints: [], role: 'auto' } as any),
      ).rejects.toThrow('Not the owner of this transport')
    })
  })

  describe('produce', () => {
    it('rejects an unauthorized caller before ever touching the transport', async () => {
      await expect(
        service.produce(CALL_A, USER_1, 'nonexistent-transport', 'audio', opusRtpParameters),
      ).rejects.toThrow('Not an authorized participant of this call')
    })

    it("rejects producing on another user's transport even within the same call", async () => {
      service.authorizePeer(CALL_A, USER_1)
      service.authorizePeer(CALL_A, USER_2)
      const transport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')

      await expect(
        service.produce(CALL_A, USER_2, transport.id, 'audio', opusRtpParameters),
      ).rejects.toThrow('Not the owner of this transport')
    })

    it('succeeds for the transport owner, authorized in this exact call', async () => {
      service.authorizePeer(CALL_A, USER_1)
      const transport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')

      const producer = await service.produce(CALL_A, USER_1, transport.id, 'audio', opusRtpParameters)
      expect(producer.id).toBeTruthy()
    })
  })

  describe('consume — the cross-call media hijack this fix closes', () => {
    it('refuses to let a peer in call B consume a producer that belongs to call A', async () => {
      // User 1 is a legitimate participant of call A and produces audio there.
      service.authorizePeer(CALL_A, USER_1)
      const producerTransport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')
      const producer = await service.produce(CALL_A, USER_1, producerTransport.id, 'audio', opusRtpParameters)

      // User 2 is a legitimate participant of an UNRELATED call B, and
      // somehow obtains user 1's producerId (leaked broadcast, guessed ID,
      // whatever). Before this fix, consume() had no concept of "does this
      // producer belong to the caller's call" and would have handed back
      // the live audio.
      service.authorizePeer(CALL_B, USER_2)
      const consumerTransport = await service.createWebRtcTransport(CALL_B, USER_2, 'recv')

      await expect(
        service.consume(
          CALL_B,
          USER_2,
          consumerTransport.id,
          producer.id,
          service.getRtpCapabilities(),
        ),
      ).rejects.toThrow('Producer does not belong to this call')
    })

    it('allows a legitimate same-call peer to consume', async () => {
      service.authorizePeer(CALL_A, USER_1)
      const producerTransport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')
      const producer = await service.produce(CALL_A, USER_1, producerTransport.id, 'audio', opusRtpParameters)

      service.authorizePeer(CALL_A, USER_2)
      const consumerTransport = await service.createWebRtcTransport(CALL_A, USER_2, 'recv')

      const consumer = await service.consume(
        CALL_A,
        USER_2,
        consumerTransport.id,
        producer.id,
        service.getRtpCapabilities(),
      )
      expect(consumer.id).toBeTruthy()
      expect(consumer.producerId).toBe(producer.id)
    })
  })

  describe('closeProducer', () => {
    it("refuses to let another user close someone else's producer", async () => {
      service.authorizePeer(CALL_A, USER_1)
      const transport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')
      const producer = await service.produce(CALL_A, USER_1, transport.id, 'audio', opusRtpParameters)

      await expect(
        service.closeProducer(CALL_A, USER_2, producer.id),
      ).rejects.toThrow('Not the owner of this producer')
    })
  })

  describe('resumeConsumer', () => {
    it("refuses to let another user resume someone else's consumer", async () => {
      service.authorizePeer(CALL_A, USER_1)
      const producerTransport = await service.createWebRtcTransport(CALL_A, USER_1, 'send')
      const producer = await service.produce(CALL_A, USER_1, producerTransport.id, 'audio', opusRtpParameters)

      service.authorizePeer(CALL_A, USER_2)
      const consumerTransport = await service.createWebRtcTransport(CALL_A, USER_2, 'recv')
      const consumer = await service.consume(
        CALL_A, USER_2, consumerTransport.id, producer.id, service.getRtpCapabilities(),
      )

      await expect(
        service.resumeConsumer(consumer.id, USER_1),
      ).rejects.toThrow('Not the owner of this consumer')
    })
  })
})
