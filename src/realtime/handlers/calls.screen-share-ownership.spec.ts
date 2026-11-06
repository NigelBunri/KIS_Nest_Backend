import { registerCallHandlers, releaseScreenShareOwnerOnDisconnect, CallsDeps } from './calls'

// Regression coverage for the screen-share ownership policy added this
// pass: previously ANY call participant could start sharing their screen
// while someone else already was - there was no check anywhere (client or
// backend), so both screen tracks would silently collide on every peer
// connection with no indication to either user why the picture kept
// changing. Also covers the "presenter leaves mid-share" lifecycle gap:
// leaving a call (call.leave) without explicitly toggling sharing off first
// previously left every other participant's UI stuck showing that user as
// still sharing forever, since nothing else ever re-emits call.screen_share
// to clear it.
//
// activeScreenSharers (the map backing this policy) is module-level state
// keyed by conversationId - each test below uses its own unique
// conversationId so tests never leak state into one another.

function makeSocket(userId: string) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId, token: 'jwt' },
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler)
    }),
    join: jest.fn(),
    emit: jest.fn(),
  }
  return { socket, handlers }
}

function makeServer() {
  const emitsByRoom = new Map<string, jest.Mock>()
  const server: any = {
    to: jest.fn((room: string) => {
      if (!emitsByRoom.has(room)) emitsByRoom.set(room, jest.fn())
      return { emit: emitsByRoom.get(room) }
    }),
    in: jest.fn(() => ({ socketsJoin: jest.fn() })),
  }
  return { server, emitsByRoom }
}

function makeDeps(overrides: Partial<CallsDeps> = {}): CallsDeps {
  return {
    djangoConversationClient: {
      assertMember: jest.fn().mockResolvedValue(undefined),
      checkBlockedAmong: jest.fn().mockResolvedValue([]),
    },
    callsService: {
      getCall: jest.fn().mockResolvedValue({ status: 'active' }),
      setParticipantStatus: jest.fn(),
      appendSignal: jest.fn(),
      endIfNoActiveParticipants: jest.fn().mockResolvedValue(false),
    },
    ...overrides,
  } as CallsDeps
}

describe('call.screen_share ownership policy', () => {
  it('allows the first participant to start sharing', async () => {
    const { socket, handlers } = makeSocket('user-1')
    const { server } = makeServer()
    const ack = jest.fn()
    registerCallHandlers(server as any, socket, makeDeps())

    await handlers.get('call.screen_share')!({ conversationId: 'conv-ss-1', enabled: true }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('rejects a second, different participant while the first is still sharing', async () => {
    const { server } = makeServer()
    const deps = makeDeps()

    const { socket: socket1, handlers: h1 } = makeSocket('user-1')
    registerCallHandlers(server as any, socket1, deps)
    await h1.get('call.screen_share')!({ conversationId: 'conv-ss-2', enabled: true }, jest.fn())

    const { socket: socket2, handlers: h2 } = makeSocket('user-2')
    registerCallHandlers(server as any, socket2, deps)
    const ack2 = jest.fn()
    await h2.get('call.screen_share')!({ conversationId: 'conv-ss-2', enabled: true }, ack2)

    expect(ack2).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: 'SCREEN_SHARE_IN_USE' }),
    )
  })

  it('lets the SAME user toggle off then on again without being blocked by themselves', async () => {
    const { server } = makeServer()
    const deps = makeDeps()
    const { socket, handlers } = makeSocket('user-1')
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.screen_share')!({ conversationId: 'conv-ss-3', enabled: true }, jest.fn())
    await handlers.get('call.screen_share')!({ conversationId: 'conv-ss-3', enabled: false }, jest.fn())
    const ackSecondStart = jest.fn()
    await handlers.get('call.screen_share')!({ conversationId: 'conv-ss-3', enabled: true }, ackSecondStart)

    expect(ackSecondStart).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('frees up sharing for others once the original sharer stops', async () => {
    const { server } = makeServer()
    const deps = makeDeps()

    const { socket: socket1, handlers: h1 } = makeSocket('user-1')
    registerCallHandlers(server as any, socket1, deps)
    await h1.get('call.screen_share')!({ conversationId: 'conv-ss-4', enabled: true }, jest.fn())
    await h1.get('call.screen_share')!({ conversationId: 'conv-ss-4', enabled: false }, jest.fn())

    const { socket: socket2, handlers: h2 } = makeSocket('user-2')
    registerCallHandlers(server as any, socket2, deps)
    const ack2 = jest.fn()
    await h2.get('call.screen_share')!({ conversationId: 'conv-ss-4', enabled: true }, ack2)

    expect(ack2).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })
})

describe('call.leave clears a stale screen-share badge when the presenter leaves mid-share', () => {
  it('broadcasts call.screen_share enabled:false for the leaving user if they were the active sharer', async () => {
    const { server, emitsByRoom } = makeServer()
    const deps = makeDeps()

    const { socket, handlers } = makeSocket('user-1')
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.screen_share')!(
      { conversationId: 'conv-ss-5', enabled: true }, jest.fn(),
    )

    await handlers.get('call.leave')!(
      { conversationId: 'conv-ss-5', callId: 'call-5' }, jest.fn(),
    )

    const convRoomEmit = emitsByRoom.get('conv:conv-ss-5')
    expect(convRoomEmit).toBeDefined()
    expect(convRoomEmit).toHaveBeenCalledWith(
      'call.screen_share',
      expect.objectContaining({ conversationId: 'conv-ss-5', userId: 'user-1', enabled: false }),
    )

    // And sharing must actually be free again for the next participant.
    const { socket: socket2, handlers: h2 } = makeSocket('user-2')
    registerCallHandlers(server as any, socket2, deps)
    const ack2 = jest.fn()
    await h2.get('call.screen_share')!({ conversationId: 'conv-ss-5', enabled: true }, ack2)
    expect(ack2).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('does not emit an extra screen_share broadcast for a participant who leaves and was never sharing', async () => {
    const { server, emitsByRoom } = makeServer()
    const deps = makeDeps()
    const { socket, handlers } = makeSocket('user-3')
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.leave')!(
      { conversationId: 'conv-ss-6', callId: 'call-6' }, jest.fn(),
    )

    const convRoomEmit = emitsByRoom.get('conv:conv-ss-6')
    const screenShareCalls = (convRoomEmit?.mock.calls ?? []).filter(([event]) => event === 'call.screen_share')
    expect(screenShareCalls).toHaveLength(0)
  })
})

// Regression coverage added for the follow-up pass: fire-and-forget emit on
// the client meant a genuinely simultaneous attempt (two taps within the
// same instant, before either device has heard about the other's) had no
// reliable way for the loser to find out they were rejected. The ownership
// check itself (Map.get/set, synchronous JS) was already race-free on the
// SERVER - these tests exercise that guarantee under truly concurrent
// (Promise.all, not sequentially-awaited) handler invocations, which is
// the scenario the client-side ack fix now actually surfaces to the user.
describe('call.screen_share simultaneous attempts (truly concurrent, not sequential)', () => {
  it('grants exactly one of two participants who both request sharing at the same instant', async () => {
    const { server } = makeServer()
    const deps = makeDeps()

    const { socket: socket1, handlers: h1 } = makeSocket('user-1')
    registerCallHandlers(server as any, socket1, deps)
    const { socket: socket2, handlers: h2 } = makeSocket('user-2')
    registerCallHandlers(server as any, socket2, deps)

    const ack1 = jest.fn()
    const ack2 = jest.fn()
    // No `await` between these two - both handlers run concurrently against
    // the same conversationId, exactly like two users tapping "Share"
    // within the same network round trip.
    await Promise.all([
      h1.get('call.screen_share')!({ conversationId: 'conv-ss-7', enabled: true }, ack1),
      h2.get('call.screen_share')!({ conversationId: 'conv-ss-7', enabled: true }, ack2),
    ])

    const results = [ack1.mock.calls[0]?.[0], ack2.mock.calls[0]?.[0]]
    const grants = results.filter((r) => r?.ok === true)
    const rejections = results.filter((r) => r?.ok === false)
    expect(grants).toHaveLength(1)
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toEqual(expect.objectContaining({ code: 'SCREEN_SHARE_IN_USE' }))
  })

  it('never reports both participants as granted, across many concurrent pairs', async () => {
    const { server } = makeServer()
    const deps = makeDeps()

    for (let i = 0; i < 20; i++) {
      const conversationId = `conv-ss-concurrent-${i}`
      const { socket: socket1, handlers: h1 } = makeSocket('user-1')
      registerCallHandlers(server as any, socket1, deps)
      const { socket: socket2, handlers: h2 } = makeSocket('user-2')
      registerCallHandlers(server as any, socket2, deps)

      const ack1 = jest.fn()
      const ack2 = jest.fn()
      await Promise.all([
        h1.get('call.screen_share')!({ conversationId, enabled: true }, ack1),
        h2.get('call.screen_share')!({ conversationId, enabled: true }, ack2),
      ])

      const grants = [ack1.mock.calls[0]?.[0], ack2.mock.calls[0]?.[0]].filter((r) => r?.ok === true)
      expect(grants).toHaveLength(1)
    }
  })
})

// Regression coverage for the follow-up pass's second fix: a presenter whose
// socket merely disconnects (backgrounded, network drop, killed) never hit
// registerLeaveHandler's cleanup (that only runs for an explicit call.leave)
// - without releaseScreenShareOwnerOnDisconnect, the ownership lock stayed
// held forever for a sharer who was never coming back.
describe('releaseScreenShareOwnerOnDisconnect (disconnect-grace cleanup)', () => {
  it('clears the lock when called for the actual current sharer', async () => {
    const { server } = makeServer()
    const deps = makeDeps()
    const { socket, handlers } = makeSocket('user-1')
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.screen_share')!({ conversationId: 'conv-ss-8', enabled: true }, jest.fn())

    expect(releaseScreenShareOwnerOnDisconnect('conv-ss-8', 'user-1')).toBe(true)

    // And sharing must actually be free again for the next participant -
    // mirrors the "frees up sharing for others" test above, but via the
    // disconnect path instead of an explicit stop/leave.
    const { socket: socket2, handlers: h2 } = makeSocket('user-2')
    registerCallHandlers(server as any, socket2, deps)
    const ack2 = jest.fn()
    await h2.get('call.screen_share')!({ conversationId: 'conv-ss-8', enabled: true }, ack2)
    expect(ack2).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('does nothing and returns false when called for a user who is not the current sharer', async () => {
    const { server } = makeServer()
    const deps = makeDeps()
    const { socket, handlers } = makeSocket('user-1')
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.screen_share')!({ conversationId: 'conv-ss-9', enabled: true }, jest.fn())

    // user-2 disconnecting must not clear user-1's lock.
    expect(releaseScreenShareOwnerOnDisconnect('conv-ss-9', 'user-2')).toBe(false)

    const { socket: socket3, handlers: h3 } = makeSocket('user-3')
    registerCallHandlers(server as any, socket3, deps)
    const ack3 = jest.fn()
    await h3.get('call.screen_share')!({ conversationId: 'conv-ss-9', enabled: true }, ack3)
    expect(ack3).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: 'SCREEN_SHARE_IN_USE' }),
    )
  })

  it('returns false and is a no-op for a conversation with no active sharer at all', () => {
    expect(releaseScreenShareOwnerOnDisconnect('conv-ss-10-never-shared', 'user-1')).toBe(false)
  })
})
