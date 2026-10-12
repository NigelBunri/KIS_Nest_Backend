import { registerCallHandlers, CallsDeps } from './calls'
import { rooms } from '../../chat/chat.types'

// Regression coverage for the participant-identity bug: "both users can see
// the same participant name during a call". Root cause (traced end to end,
// see the mobile-side fix in messagesUtils.ts and SocketProvider.tsx):
//
// 1. None of the mobile client's call.answer emits ever included a
//    displayName field, so enrichedPayload.displayName (spread straight
//    from the client payload, with no server-side override) was always
//    undefined for CALL_ANSWER — the caller's screen fell back to a
//    generic "Participant" label for whoever just answered.
// 2. For CALL_OFFER, the mobile client only ever sent `title` (the
//    CALLER's own call label, which — after ALSO fixing a separate bug in
//    directConversationName — correctly equals the RECIPIENT's name from
//    the caller's point of view). The recipient's socket handler used to
//    prefer `payload.title` for its own incoming-call title, which meant
//    the recipient saw THEIR OWN name reflected back at them.
//
// The fix: `enrichedPayload.displayName` (and `.fromPhone`) are now
// authoritatively overridden from the AUTHENTICATED principal performing
// the action — exactly like `fromUserId` already was — for every call
// event, never trusting whatever (if anything) the client payload says.

function makeSocket(principal: Record<string, any>) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal,
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

describe('call.offer broadcasts the authoritative caller identity', () => {
  it('sets displayName/fromPhone from the authenticated principal, ignoring anything the client sent', async () => {
    const { socket, handlers } = makeSocket({ userId: 'caller-1', username: 'Real Caller Name', phone: '+15550001111', token: 'jwt' })
    const { server, emitsByRoom } = makeServer()
    const deps = makeDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.offer')!(
      {
        conversationId: 'conv-1',
        callId: 'call-1',
        inviteeUserIds: ['invitee-1'],
        // A spoofed/stale client-supplied value — must never win.
        displayName: 'Someone Else Entirely',
      },
      jest.fn(),
    )

    expect(emitsByRoom.get(rooms.userRoom('invitee-1'))).toHaveBeenCalledWith(
      'call.offer',
      expect.objectContaining({ displayName: 'Real Caller Name', fromPhone: '+15550001111', fromUserId: 'caller-1' }),
    )
  })
})

describe('call.answer broadcasts the authoritative responder identity to the caller', () => {
  function makeAnswerDeps(overrides: Partial<CallsDeps> = {}): CallsDeps {
    return makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'caller-1',
          callType: 'voice',
          participants: [],
        }),
        setParticipantStatus: jest.fn(),
        appendSignal: jest.fn(),
        getCallCreator: jest.fn().mockResolvedValue('caller-1'),
      },
      ...overrides,
    } as Partial<CallsDeps>)
  }

  it('the caller receives the real name of whoever just answered, not a generic placeholder', async () => {
    const { socket, handlers } = makeSocket({ userId: 'responder-1', username: 'Real Responder Name', phone: '+15550002222', token: 'jwt' })
    const { server, emitsByRoom } = makeServer()
    const deps = makeAnswerDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!(
      { conversationId: 'conv-1', callId: 'call-1' }, // no displayName field at all — matches the real mobile client
      jest.fn(),
    )

    expect(emitsByRoom.get(rooms.userRoom('caller-1'))).toHaveBeenCalledWith(
      'call.answer',
      expect.objectContaining({ displayName: 'Real Responder Name', fromUserId: 'responder-1' }),
    )
  })

  it('a spoofed client-supplied displayName on call.answer cannot impersonate someone else', async () => {
    const { socket, handlers } = makeSocket({ userId: 'responder-1', username: 'Real Responder Name', token: 'jwt' })
    const { server, emitsByRoom } = makeServer()
    const deps = makeAnswerDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!(
      { conversationId: 'conv-1', callId: 'call-1', displayName: 'Impersonated Name' },
      jest.fn(),
    )

    expect(emitsByRoom.get(rooms.userRoom('caller-1'))).toHaveBeenCalledWith(
      'call.answer',
      expect.objectContaining({ displayName: 'Real Responder Name' }),
    )
  })
})

describe('call.participant.joined broadcasts the joiner\'s real name', () => {
  it('includes displayName for a fresh join (group call)', async () => {
    const { socket, handlers } = makeSocket({ userId: 'joiner-1', username: 'Real Joiner Name', token: 'jwt' })
    const { server, emitsByRoom } = makeServer()
    const deps = makeDeps({
      callsService: {
        ensureCallExistsOrThrow: jest.fn().mockResolvedValue({
          createdBy: 'host-1',
          callType: 'voice-group',
          participants: [],
        }),
        setParticipantStatus: jest.fn(),
        appendSignal: jest.fn(),
      },
    } as Partial<CallsDeps>)
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.answer')!({ conversationId: 'conv-1', callId: 'call-1' }, jest.fn())

    expect(emitsByRoom.get(rooms.convRoom('conv-1'))).toHaveBeenCalledWith(
      'call.participant.joined',
      expect.objectContaining({ userId: 'joiner-1', displayName: 'Real Joiner Name' }),
    )
  })
})
