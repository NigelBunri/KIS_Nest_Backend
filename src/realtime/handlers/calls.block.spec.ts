import { registerCallHandlers, CallsDeps } from './calls'
import { rooms } from '../../chat/chat.types'

// Standalone calls (`standalone:<callId>`) have no Django conversation
// record, so they skip assertMember() entirely (see calls.ts) and
// previously had NO interpersonal-block check of any kind - a blocked
// user could still ring the person who blocked them via call.offer.
// checkBlockedAmong (DjangoConversationClient) closes that gap for the
// standalone path specifically; real conversations already get theirs
// from ws-perms/assertMember.

function makeSocket() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId: 'user-1', token: 'jwt' },
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
      assertMember: jest.fn(),
      checkBlockedAmong: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  } as CallsDeps
}

describe('call.offer standalone block filtering', () => {
  it('does not ring an invitee who blocked (or was blocked by) the caller', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn(),
        checkBlockedAmong: jest.fn().mockResolvedValue(['user-2']),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.offer')!(
      { conversationId: 'standalone:call-1', callId: 'call-1', inviteeUserIds: ['user-2', 'user-3'] },
      jest.fn(),
    )

    expect(deps.djangoConversationClient.checkBlockedAmong).toHaveBeenCalledWith('user-1', ['user-2', 'user-3'])
    expect(emitsByRoom.get(rooms.userRoom('user-3'))).toHaveBeenCalledWith('call.offer', expect.anything())
    expect(emitsByRoom.has(rooms.userRoom('user-2'))).toBe(false)
  })

  it('rejects the whole offer with BLOCKED when every invitee is blocked', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn(),
        checkBlockedAmong: jest.fn().mockResolvedValue(['user-2']),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.offer')!(
      { conversationId: 'standalone:call-1', callId: 'call-1', inviteeUserIds: ['user-2'] },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: 'BLOCKED' }),
    )
    expect(emitsByRoom.has(rooms.userRoom('user-2'))).toBe(false)
  })

  it('does not run the block check for a real (non-standalone) conversation offer', async () => {
    const { socket, handlers } = makeSocket()
    const { server } = makeServer()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn(),
        checkBlockedAmong: jest.fn().mockResolvedValue(['user-2']),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.offer')!(
      { conversationId: 'conv-123', callId: 'call-1', inviteeUserIds: ['user-2'] },
      jest.fn(),
    )

    expect(deps.djangoConversationClient.checkBlockedAmong).not.toHaveBeenCalled()
  })

  it('rings everyone when checkBlockedAmong is not wired (no regression for older deps)', async () => {
    const { socket, handlers } = makeSocket()
    const { server } = makeServer()
    const deps = makeDeps({
      djangoConversationClient: { assertMember: jest.fn() },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.offer')!(
      { conversationId: 'standalone:call-1', callId: 'call-1', inviteeUserIds: ['user-2', 'user-3'] },
      jest.fn(),
    )

    expect(server.to).toHaveBeenCalledWith(rooms.userRoom('user-2'))
    expect(server.to).toHaveBeenCalledWith(rooms.userRoom('user-3'))
  })
})

describe('call.answer standalone join block check', () => {
  // Standalone calls skip assertMember and setParticipantStatus will
  // happily add anyone who reaches it as a brand-new participant with no
  // invite-list check by design (open invite-link joining is intentional).
  // A block between the joiner and the call's creator must still stop the
  // join outright - otherwise blocking someone does nothing to stop them
  // joining a call THEY started.
  function makeAnswerDeps(overrides: Partial<CallsDeps> = {}): CallsDeps {
    return makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'user-1',
          callType: 'voice',
          participants: [],
        }),
        setParticipantStatus: jest.fn(),
        appendSignal: jest.fn(),
      },
      ...overrides,
    } as Partial<CallsDeps>)
  }

  it('rejects a join from someone blocked by (or who blocked) the call creator', async () => {
    const { socket, handlers } = makeSocket()
    socket.principal = { userId: 'user-2', token: 'jwt' }
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeAnswerDeps({
      djangoConversationClient: {
        assertMember: jest.fn(),
        checkBlockedAmong: jest.fn().mockResolvedValue(['user-1']),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(deps.djangoConversationClient.checkBlockedAmong).toHaveBeenCalledWith('user-2', ['user-1'])
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'BLOCKED' }))
    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
  })

  it('allows the join when there is no block between joiner and creator', async () => {
    const { socket, handlers } = makeSocket()
    socket.principal = { userId: 'user-2', token: 'jwt' }
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeAnswerDeps({
      djangoConversationClient: {
        assertMember: jest.fn(),
        checkBlockedAmong: jest.fn().mockResolvedValue([]),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'standalone:call-1', 'call-1', 'user-2', 'joined',
    )
  })

  it('does not run the block check when the caller is the call creator', async () => {
    const { socket, handlers } = makeSocket()
    socket.principal = { userId: 'user-1', token: 'jwt' }
    const { server } = makeServer()
    const deps = makeAnswerDeps({
      djangoConversationClient: {
        assertMember: jest.fn(),
        checkBlockedAmong: jest.fn().mockResolvedValue([]),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, jest.fn())

    expect(deps.djangoConversationClient.checkBlockedAmong).not.toHaveBeenCalled()
  })

  it('does not run the block check for a real (non-standalone) conversation answer', async () => {
    const { socket, handlers } = makeSocket()
    socket.principal = { userId: 'user-2', token: 'jwt' }
    const { server } = makeServer()
    const deps = makeAnswerDeps({
      djangoConversationClient: {
        assertMember: jest.fn(),
        checkBlockedAmong: jest.fn().mockResolvedValue([]),
      },
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, jest.fn())

    expect(deps.djangoConversationClient.checkBlockedAmong).not.toHaveBeenCalled()
  })
})
