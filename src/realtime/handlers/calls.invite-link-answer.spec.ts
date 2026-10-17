import { registerCallHandlers, CallsDeps } from './calls'

// Reproduces the reported production bug: a user taps a valid call
// invitation link (CallJoinScreen.tsx -> joinExistingCall -> socket emit
// 'call.answer' for a REAL, conversation-backed call they are not a
// Django member of) and the call immediately looks like it ended. Root
// cause: createCallHandler unconditionally called
// djangoConversationClient.assertMember() for any non-standalone
// conversationId before even checking whether the call had an invite
// token — so a non-member joining via a perfectly valid invite link was
// always rejected by assertMember, the client's ack handler
// (SocketProvider.tsx joinExistingCall) treated that rejection as
// "the call is no longer available" and tore down WebRTC immediately.

function makeSocket(userId = 'user-2') {
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
  const roomSocketsJoin = jest.fn()
  const server: any = {
    to: jest.fn((room: string) => {
      if (!emitsByRoom.has(room)) emitsByRoom.set(room, jest.fn())
      return { emit: emitsByRoom.get(room) }
    }),
    in: jest.fn(() => ({ socketsJoin: roomSocketsJoin })),
  }
  return { server, emitsByRoom }
}

function makeDeps(overrides: Partial<CallsDeps> = {}): CallsDeps {
  return {
    djangoConversationClient: {
      assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
      checkBlockedAmong: jest.fn().mockResolvedValue([]),
    },
    callsService: {
      ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
        createdBy: 'user-1',
        callType: 'voice',
        status: 'ringing',
        participants: [],
      }),
      hasActiveInviteToken: jest.fn().mockResolvedValue(true),
      setParticipantStatus: jest.fn(),
      appendSignal: jest.fn(),
    },
    ...overrides,
  } as CallsDeps
}

describe('call.answer invite-link bypass for a real (non-standalone) conversation', () => {
  it('lets a non-member join when the call has an active invite token', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(deps.djangoConversationClient.assertMember).toHaveBeenCalled()
    expect((deps.callsService as any).hasActiveInviteToken).toHaveBeenCalledWith('conv-123', 'call-1')
    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-123', 'call-1', 'user-2', 'joined',
    )
    // The bug: the client's ack handler treats ok:false as "call ended" —
    // a successful bypass must never ack an error.
    expect(ack).not.toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('still rejects a non-member when the call has NO invite token (ordinary private call)', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn(),
        hasActiveInviteToken: jest.fn().mockResolvedValue(false),
        setParticipantStatus: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
  })

  it('never calls hasActiveInviteToken when the caller IS already a conversation member', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn().mockResolvedValue(undefined),
        checkBlockedAmong: jest.fn().mockResolvedValue([]),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, jest.fn())

    expect((deps.callsService as any).hasActiveInviteToken).not.toHaveBeenCalled()
    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-123', 'call-1', 'user-2', 'joined',
    )
  })

  it('does NOT extend the bypass to call.offer — a non-member sending an offer is still rejected', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.offer')!(
      { conversationId: 'conv-123', callId: 'call-1', callType: 'voice' },
      ack,
    )

    expect((deps.callsService as any).hasActiveInviteToken).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('still enforces the interpersonal block check for an invite-link joiner', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
        checkBlockedAmong: jest.fn().mockResolvedValue(['user-1']),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(deps.djangoConversationClient.checkBlockedAmong).toHaveBeenCalledWith('user-2', ['user-1'])
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'BLOCKED' }))
    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
  })

  it('bypasses membership for call.ice from an invite-link joiner', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.ice')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).not.toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('bypasses membership for call.end from an invite-link joiner', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'user-1', callType: 'voice', status: 'active', participants: [],
        }),
        hasActiveInviteToken: jest.fn().mockResolvedValue(true),
        setParticipantStatus: jest.fn(),
        endIfNoActiveParticipants: jest.fn(),
        appendSignal: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.end')!({ conversationId: 'conv-123', callId: 'call-1', reason: 'left' }, ack)

    expect(ack).not.toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })
})
