import { registerCallHandlers, CallsDeps } from './calls'

// Companion to calls.invite-link-answer.spec.ts, for the OTHER way a
// non-member legitimately ends up with a reason to join a call: being
// personally invited via call.invite (the "Add to call" picker) rather
// than following a shared link. call.invite pushes CALL_OFFER + a real
// incoming-call push to the invitee and lets them tap Answer — but their
// own call.answer previously still only checked hasActiveInviteToken,
// which is unrelated to being personally invited, so a user invited into
// a group call they weren't already a Django member of got rung, tapped
// Answer, and was immediately rejected right back out by assertMember.

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
        callType: 'video-group',
        status: 'active',
        participants: [],
      }),
      hasActiveInviteToken: jest.fn().mockResolvedValue(false),
      isInvitedParticipant: jest.fn().mockResolvedValue(true),
      setParticipantStatus: jest.fn(),
      appendSignal: jest.fn(),
    },
    ...overrides,
  } as CallsDeps
}

describe('call.answer direct-invite bypass (call.invite, not a shared link)', () => {
  it('lets a directly-invited non-member answer the call', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(deps.djangoConversationClient.assertMember).toHaveBeenCalled()
    expect((deps.callsService as any).isInvitedParticipant).toHaveBeenCalledWith('conv-123', 'call-1', 'user-2')
    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-123', 'call-1', 'user-2', 'joined',
    )
    expect(ack).not.toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('still rejects a non-member who was never invited and has no invite token either', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn(),
        hasActiveInviteToken: jest.fn().mockResolvedValue(false),
        isInvitedParticipant: jest.fn().mockResolvedValue(false),
        setParticipantStatus: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
  })

  it('never checks isInvitedParticipant when the caller IS already a conversation member', async () => {
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

    expect((deps.callsService as any).isInvitedParticipant).not.toHaveBeenCalled()
    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-123', 'call-1', 'user-2', 'joined',
    )
  })
})

// REAL root cause of "a user can't join an ongoing call": the
// isInvitedParticipant bypass above only cleared the Django-membership
// check. A second, independent gate further down createCallHandler's
// CALL_ANSWER branch — a hardcoded MAX_PARTICIPANTS cap keyed on
// callToJoin.callType — still rejected a 3rd invited person with
// CALL_FULL, because a 1:1 call's callType is set once at creation and
// stays 'voice'/'video' (cap 2) forever, even after someone is
// legitimately invited onto it.
describe('call.answer participant cap for a 1:1 call escalated via call.invite', () => {
  it('lets a 3rd invited participant answer a voice call that already has its 2 original parties joined', async () => {
    const { socket, handlers } = makeSocket('user-3')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
        checkBlockedAmong: jest.fn().mockResolvedValue([]),
      },
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'user-1',
          callType: 'voice',
          status: 'active',
          participants: [
            { userId: 'user-1', status: 'joined' },
            { userId: 'user-2', status: 'joined' },
            { userId: 'user-3', status: 'invited' },
          ],
        }),
        hasActiveInviteToken: jest.fn().mockResolvedValue(false),
        isInvitedParticipant: jest.fn().mockResolvedValue(true),
        setParticipantStatus: jest.fn(),
        appendSignal: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).not.toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'CALL_FULL' }))
    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-123', 'call-1', 'user-3', 'joined',
    )
  })

  it('still caps a genuine 1:1 voice call at 2 when nobody was ever invited onto it', async () => {
    const { socket, handlers } = makeSocket('user-3')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn().mockResolvedValue(undefined),
        checkBlockedAmong: jest.fn().mockResolvedValue([]),
      },
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'user-1',
          callType: 'voice',
          status: 'active',
          participants: [
            { userId: 'user-1', status: 'joined' },
            { userId: 'user-2', status: 'joined' },
          ],
        }),
        setParticipantStatus: jest.fn(),
        appendSignal: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'CALL_FULL' }))
    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
  })
})
