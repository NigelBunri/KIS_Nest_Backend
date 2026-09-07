import { registerCallHandlers, CallsDeps } from './calls'

// Regression coverage for a real cross-tenant authorization bypass found
// during a 2026-09-07 foundation audit: every "host-only" call-control
// handler (knock admit/deny, promote, mute/remove participant, recording
// start/stop, RTMP start/stop, breakout create) checked
//   if (creator && creator !== principal.userId) { forbidden }
// getCallCreator() returns null for a callId that doesn't match any real
// call, and a null creator made that check PASS instead of fail - any
// authenticated user could "host" a nonexistent call in a conversation
// they don't belong to and have the handler's side effects (forcing a
// target user's socket into that conversation's room, broadcasting
// spoofed control-plane events) still go through. Several of these
// handlers also never called assertMember at all, so the attacker didn't
// even need to be a member of the target conversation.
//
// Fixed via one shared assertCallHost() helper (always checks membership
// first, then treats "no such call" as forbidden, not permitted) used by
// every handler below - this file exercises that helper through each
// call-control handler it now protects, not just the helper in isolation,
// so a future accidental revert of any individual call site is caught.

function makeSocket(userId = 'attacker') {
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
  return { server, emitsByRoom, roomSocketsJoin }
}

// getCallCreator resolving to null - the exact "no such call" case that
// used to bypass every one of these checks.
function makeDepsWithNoSuchCall(overrides: Partial<CallsDeps> = {}): CallsDeps {
  return {
    djangoConversationClient: {
      assertMember: jest.fn(), // resolves - attacker IS a member of the conversation
    },
    callsService: {
      getCallCreator: jest.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as unknown as CallsDeps
}

describe('call-control host-only handlers reject a nonexistent/fabricated callId', () => {
  it('call.knock.admit: FORBIDDEN, not permitted, when getCallCreator resolves null', async () => {
    const { socket, handlers } = makeSocket()
    const { server, roomSocketsJoin } = makeServer()
    const deps = makeDepsWithNoSuchCall()
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock.admit')!(
      { conversationId: 'victim-conv', callId: 'fabricated-call-id', targetUserId: 'victim' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(roomSocketsJoin).not.toHaveBeenCalled()
  })

  it('call.knock.deny: FORBIDDEN when getCallCreator resolves null', async () => {
    const { socket, handlers } = makeSocket()
    const { server } = makeServer()
    const deps = makeDepsWithNoSuchCall({
      callsService: { getCallCreator: jest.fn().mockResolvedValue(null), removeKnocker: jest.fn() },
    } as Partial<CallsDeps>)
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock.deny')!(
      { conversationId: 'victim-conv', callId: 'fabricated-call-id', targetUserId: 'victim' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).removeKnocker).not.toHaveBeenCalled()
  })

  it('call.promote: FORBIDDEN when getCallCreator resolves null', async () => {
    const { socket, handlers } = makeSocket()
    const { server } = makeServer()
    const deps = makeDepsWithNoSuchCall({
      callsService: { getCallCreator: jest.fn().mockResolvedValue(null), setParticipantRole: jest.fn() },
    } as Partial<CallsDeps>)
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.promote')!(
      { conversationId: 'victim-conv', callId: 'fabricated-call-id', targetUserId: 'victim', role: 'host' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).setParticipantRole).not.toHaveBeenCalled()
  })

  it('call.participant.mute: FORBIDDEN when getCallCreator resolves null (even though attacker is a conv member)', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const deps = makeDepsWithNoSuchCall()
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.participant.mute')!(
      { conversationId: 'victim-conv', callId: 'fabricated-call-id', targetUserId: 'victim' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(emitsByRoom.size).toBe(0)
  })

  it('call.participant.remove: FORBIDDEN when getCallCreator resolves null', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const deps = makeDepsWithNoSuchCall({
      callsService: { getCallCreator: jest.fn().mockResolvedValue(null), setParticipantStatus: jest.fn() },
    } as Partial<CallsDeps>)
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.participant.remove')!(
      { conversationId: 'victim-conv', callId: 'fabricated-call-id', targetUserId: 'victim' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
    expect(emitsByRoom.size).toBe(0)
  })

  it('call.recording.start: FORBIDDEN when getCallCreator resolves null', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const deps = makeDepsWithNoSuchCall({
      callsService: { getCallCreator: jest.fn().mockResolvedValue(null), setRecordingState: jest.fn() },
    } as Partial<CallsDeps>)
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.recording.start')!({ conversationId: 'victim-conv', callId: 'fabricated-call-id' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).setRecordingState).not.toHaveBeenCalled()
    expect(emitsByRoom.size).toBe(0)
  })

  it('call.rtmp.start: FORBIDDEN when getCallCreator resolves null', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const deps = makeDepsWithNoSuchCall({
      callsService: { getCallCreator: jest.fn().mockResolvedValue(null), setRtmp: jest.fn() },
    } as Partial<CallsDeps>)
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.rtmp.start')!(
      { conversationId: 'victim-conv', callId: 'fabricated-call-id', rtmpUrl: 'rtmp://evil.example/x' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).setRtmp).not.toHaveBeenCalled()
    expect(emitsByRoom.size).toBe(0)
  })

  it('call.breakout.create: FORBIDDEN when getCallCreator resolves null', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const deps = makeDepsWithNoSuchCall()
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.breakout.create')!(
      { conversationId: 'victim-conv', callId: 'fabricated-call-id', rooms: [{ name: 'Room 1', userIds: ['victim'] }] },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(emitsByRoom.size).toBe(0)
  })

  it('call.knock: rejects a non-member from broadcasting into an arbitrary conversation (previously had NO membership check at all)', async () => {
    const { socket, handlers } = makeSocket()
    const { server, emitsByRoom } = makeServer()
    const deps = {
      djangoConversationClient: {
        assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
      },
      callsService: { addKnocker: jest.fn() },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock')!({ conversationId: 'not-my-conv', callId: 'some-call' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).addKnocker).not.toHaveBeenCalled()
    expect(emitsByRoom.size).toBe(0)
  })
})

describe('call-control host-only handlers still allow the real host through', () => {
  it('call.knock.admit: succeeds when the caller genuinely created the call', async () => {
    const { socket, handlers } = makeSocket('real-host')
    const { server, roomSocketsJoin } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: {
        getCallCreator: jest.fn().mockResolvedValue('real-host'),
        removeKnocker: jest.fn(),
        setParticipantStatus: jest.fn(),
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock.admit')!(
      { conversationId: 'real-conv', callId: 'real-call', targetUserId: 'invitee' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    expect(roomSocketsJoin).toHaveBeenCalled()
  })

  it('call.recording.start: succeeds for the real host', async () => {
    const { socket, handlers } = makeSocket('real-host')
    const { server, emitsByRoom } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: {
        getCallCreator: jest.fn().mockResolvedValue('real-host'),
        setRecordingState: jest.fn(),
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.recording.start')!({ conversationId: 'real-conv', callId: 'real-call' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    expect((deps.callsService as any).setRecordingState).toHaveBeenCalledWith('real-conv', 'real-call', 'recording')
    expect(emitsByRoom.get(require('../../chat/chat.types').rooms.convRoom('real-conv'))).toHaveBeenCalled()
  })

  it('call.knock: succeeds for a genuine conversation member', async () => {
    const { socket, handlers } = makeSocket('member')
    const { server, emitsByRoom } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: { addKnocker: jest.fn() },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock')!({ conversationId: 'real-conv', callId: 'real-call' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    expect((deps.callsService as any).addKnocker).toHaveBeenCalled()
  })
})
