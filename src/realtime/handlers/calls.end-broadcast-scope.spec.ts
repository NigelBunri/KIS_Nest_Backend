import { registerCallHandlers, CallsDeps } from './calls'

// Regression coverage for the PRIMARY root cause of "adding a participant
// to an active call shows a false missed-call / partially ends the call for
// others": the call.end socket handler's 'rejected'/'busy' branch always
// broadcast the raw CALL_END event to the entire conversation room,
// regardless of whether endIfNoActiveParticipants actually ended the call.
// The mobile client's call.end listener flips its local call state to
// ended/missed for ANY call.end matching its callId, with no per-recipient
// scoping - so one invitee declining/being busy was ending the call on
// every OTHER still-connected participant's screen, even though the
// backend's own call status correctly stayed 'active'/'ringing' for them.

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
      assertMember: jest.fn().mockResolvedValue(undefined),
      checkBlockedAmong: jest.fn().mockResolvedValue([]),
    },
    rateLimitService: { assert: jest.fn() },
    callsService: {
      ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
        createdBy: 'user-1',
        callType: 'video-group',
        status: 'active',
      }),
      setParticipantStatus: jest.fn(),
      endIfNoActiveParticipants: jest.fn().mockResolvedValue(false),
      endCall: jest.fn(),
      appendSignal: jest.fn(),
    },
    ...overrides,
  } as CallsDeps
}

describe('call.end broadcast scope — rejected/busy must not end the call for everyone', () => {
  it('does NOT broadcast CALL_END to the conv room when other participants are still active', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps() // endIfNoActiveParticipants resolves false
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.end')!(
      { conversationId: 'conv-123', callId: 'call-1', reason: 'rejected' },
      ack,
    )

    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-123', 'call-1', 'user-2', 'rejected', 'rejected',
    )
    // CALL_PARTICIPANT_LEFT (per-participant, non-destructive) still fires...
    expect(emitsByRoom.get('conv:conv-123')).toBeDefined()
    const convEmits = (emitsByRoom.get('conv:conv-123') as jest.Mock).mock.calls.map(c => c[0])
    expect(convEmits).toContain('call.participant.left')
    // ...but the raw call.end broadcast must be absent.
    expect(convEmits).not.toContain('call.end')
    expect(ack).not.toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('DOES broadcast CALL_END to the conv room when the decline ends the call for everyone', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'user-1',
          callType: 'voice',
          status: 'ringing',
        }),
        setParticipantStatus: jest.fn(),
        endIfNoActiveParticipants: jest.fn().mockResolvedValue(true),
        appendSignal: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.end')!(
      { conversationId: 'conv-123', callId: 'call-1', reason: 'rejected' },
      ack,
    )

    const convEmits = (emitsByRoom.get('conv:conv-123') as jest.Mock).mock.calls.map(c => c[0])
    expect(convEmits).toContain('call.end')
  })

  it('an explicit end (not rejected/busy) always broadcasts, regardless of endIfNoActiveParticipants', async () => {
    const { socket, handlers } = makeSocket('user-1')
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'user-1',
          callType: 'video-group',
          status: 'active',
        }),
        setParticipantStatus: jest.fn(),
        endIfNoActiveParticipants: jest.fn(),
        endCall: jest.fn().mockResolvedValue({ callId: 'call-1', status: 'ended' }),
        appendSignal: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.end')!(
      { conversationId: 'conv-123', callId: 'call-1', reason: 'ended_by_host' },
      ack,
    )

    expect((deps.callsService as any).endCall).toHaveBeenCalled()
    expect((deps.callsService as any).endIfNoActiveParticipants).not.toHaveBeenCalled()
    const convEmits = (emitsByRoom.get('conv:conv-123') as jest.Mock).mock.calls.map(c => c[0])
    expect(convEmits).toContain('call.end')
  })
})

// Companion fix found in the same audit: call.knock trusted a client-
// supplied `displayName` string, unlike every other identity field in this
// file (always resolved from the authenticated principal). The host's
// admission-request list is exactly the kind of surface a spoofed name
// could be used to social-engineer an admit decision.
describe('call.knock — displayName is never taken from the client payload', () => {
  it('uses the authenticated principal\'s own username, ignoring a spoofed payload.displayName', async () => {
    const { socket, handlers } = makeSocket('knocker-1')
    socket.principal.username = 'Real Name'
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        addKnocker: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.knock')!(
      { conversationId: 'conv-123', callId: 'call-1', displayName: 'Pastor John (Verified)' },
      ack,
    )

    const convEmits = (emitsByRoom.get('conv:conv-123') as jest.Mock).mock.calls
    const knockRequest = convEmits.find(c => c[0] === 'call.knock.request')
    expect(knockRequest?.[1]).toEqual(expect.objectContaining({ displayName: 'Real Name' }))
    expect(knockRequest?.[1]?.displayName).not.toBe('Pastor John (Verified)')
  })
})
