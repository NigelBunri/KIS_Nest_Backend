import { registerSfuHandlers, SfuDeps } from './sfu'
import { EVT } from '../../chat/chat.types'

// Coverage for two fixes to sfu.join (the entry point into real group
// audio/video media):
//
// 1. assertMember always threw for `standalone:<callId>` conversations (no
//    Django record), making the SFU path completely unreachable for every
//    invite-link/scheduled group call — including for the host. Fixed with
//    the same standalone-skip pattern used elsewhere in the calls code.
// 2. The participant check only excluded status 'rejected', so a user
//    sitting in the waiting room (status 'invited', set by
//    call.waiting.join before the host admits them) could call sfu.join
//    directly and receive real media access before admission — defeating
//    the entire point of a waiting room. Fixed to require 'joined' or
//    'connecting'.

function makeSocket(userId = 'user-1') {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId, token: 'jwt' },
    on: jest.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    join: jest.fn(),
  }
  return { socket, handlers }
}

function makeServer() {
  const server: any = { to: jest.fn(() => ({ emit: jest.fn() })) }
  return server
}

function makeSfuService() {
  return {
    available: true,
    authorizePeer: jest.fn(),
    getRtpCapabilities: jest.fn().mockReturnValue({}),
    getProducersForRoom: jest.fn().mockReturnValue([]),
  }
}

describe('sfu.join', () => {
  it('rejects a waiting-room participant (status "invited") from getting real media access', async () => {
    const { socket, handlers } = makeSocket('waiting-user')
    const sfuService = makeSfuService()
    const deps: SfuDeps = {
      sfuService: sfuService as any,
      djangoConversationClient: { assertMember: jest.fn() } as any,
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          participants: [{ userId: 'waiting-user', status: 'invited' }],
        }),
      },
    }
    registerSfuHandlers(makeServer(), socket, deps)
    const ack = jest.fn()

    await handlers.get(EVT.SFU_JOIN)!({ callId: 'call-1', conversationId: 'standalone:call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(sfuService.authorizePeer).not.toHaveBeenCalled()
  })

  it('allows a real joined participant through, and skips Django membership for a standalone call', async () => {
    const { socket, handlers } = makeSocket('joined-user')
    const sfuService = makeSfuService()
    const assertMember = jest.fn().mockRejectedValue(new Error('Not a conversation member'))
    const deps: SfuDeps = {
      sfuService: sfuService as any,
      djangoConversationClient: { assertMember } as any,
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          participants: [{ userId: 'joined-user', status: 'joined' }],
        }),
      },
    }
    registerSfuHandlers(makeServer(), socket, deps)
    const ack = jest.fn()

    await handlers.get(EVT.SFU_JOIN)!({ callId: 'call-1', conversationId: 'standalone:call-1' }, ack)

    expect(assertMember).not.toHaveBeenCalled()
    expect(sfuService.authorizePeer).toHaveBeenCalledWith('call-1', 'joined-user')
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('still allows the host through while their row is "connecting"', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const sfuService = makeSfuService()
    const deps: SfuDeps = {
      sfuService: sfuService as any,
      djangoConversationClient: { assertMember: jest.fn() } as any,
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          participants: [{ userId: 'host-1', status: 'connecting' }],
        }),
      },
    }
    registerSfuHandlers(makeServer(), socket, deps)
    const ack = jest.fn()

    await handlers.get(EVT.SFU_JOIN)!({ callId: 'call-1', conversationId: 'conv-1' }, ack)

    expect(sfuService.authorizePeer).toHaveBeenCalledWith('call-1', 'host-1')
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('lets a non-member who joined via invite link reach real media on a conversation-backed call', async () => {
    // A non-member admitted into an already-active call via calls.ts's
    // CALL_KNOCK/CALL_KNOCK_ADMIT (now also invite-link-aware) still hit
    // assertMember here unconditionally for a real (non-standalone)
    // conversationId - so once a group call upgraded to the SFU, they
    // could never actually reach live audio/video, only the P2P mesh.
    const { socket, handlers } = makeSocket('invite-guest')
    const sfuService = makeSfuService()
    const assertMember = jest.fn().mockRejectedValue(new Error('Not a conversation member'))
    const hasActiveInviteToken = jest.fn().mockResolvedValue(true)
    const deps: SfuDeps = {
      sfuService: sfuService as any,
      djangoConversationClient: { assertMember } as any,
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          participants: [{ userId: 'invite-guest', status: 'joined' }],
        }),
        hasActiveInviteToken,
      },
    }
    registerSfuHandlers(makeServer(), socket, deps)
    const ack = jest.fn()

    await handlers.get(EVT.SFU_JOIN)!({ callId: 'call-1', conversationId: 'conv-1' }, ack)

    expect(assertMember).toHaveBeenCalled()
    expect(hasActiveInviteToken).toHaveBeenCalledWith('conv-1', 'call-1')
    expect(sfuService.authorizePeer).toHaveBeenCalledWith('call-1', 'invite-guest')
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('still rejects a non-member with no active invite token on a conversation-backed call', async () => {
    const { socket, handlers } = makeSocket('stranger')
    const sfuService = makeSfuService()
    const assertMember = jest.fn().mockRejectedValue(new Error('Not a conversation member'))
    const deps: SfuDeps = {
      sfuService: sfuService as any,
      djangoConversationClient: { assertMember } as any,
      callsService: {
        getCall: jest.fn(),
        hasActiveInviteToken: jest.fn().mockResolvedValue(false),
      },
    }
    registerSfuHandlers(makeServer(), socket, deps)
    const ack = jest.fn()

    await handlers.get(EVT.SFU_JOIN)!({ callId: 'call-1', conversationId: 'conv-1' }, ack)

    expect(sfuService.authorizePeer).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('rejects a removed participant (status "left")', async () => {
    const { socket, handlers } = makeSocket('left-user')
    const sfuService = makeSfuService()
    const deps: SfuDeps = {
      sfuService: sfuService as any,
      djangoConversationClient: { assertMember: jest.fn() } as any,
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          participants: [{ userId: 'left-user', status: 'left' }],
        }),
      },
    }
    registerSfuHandlers(makeServer(), socket, deps)
    const ack = jest.fn()

    await handlers.get(EVT.SFU_JOIN)!({ callId: 'call-1', conversationId: 'conv-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })
})
