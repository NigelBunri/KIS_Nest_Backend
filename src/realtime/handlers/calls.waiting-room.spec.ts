import { registerCallHandlers, CallsDeps } from './calls'

// Coverage for the waiting-room / scheduled-call-start feature:
//
// 1. assertCallHost (used by knock admit/deny, promote, mute, etc.) and
//    call.waiting.join both unconditionally called djangoConversationClient
//    .assertMember() even for `standalone:<callId>` conversations, which
//    have no Django conversation record — assertMember always threw for
//    them, breaking the host's own admit/deny controls and the waiting room
//    for every invite-link/scheduled call. Fixed by skipping Django
//    membership for standalone conversationIds, same pattern already used
//    by call.offer/answer/ice/end.
// 2. call.scheduled.start is the host-only action that transitions a
//    scheduled call from 'pending' to 'ringing' using the SAME callId — it
//    must reject a non-host outright and must not require Django
//    membership for a standalone call either.

function makeSocket(userId = 'host-1') {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId, token: 'jwt' },
    on: jest.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
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

describe('assertCallHost — standalone calls', () => {
  it('call.knock.admit succeeds for the real host of a standalone call without any Django membership record', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server } = makeServer()
    const assertMember = jest.fn().mockRejectedValue(new Error('Not a conversation member'))
    const deps = {
      djangoConversationClient: { assertMember },
      callsService: {
        getCallCreator: jest.fn().mockResolvedValue('host-1'),
        removeKnocker: jest.fn(),
        setParticipantStatus: jest.fn(),
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock.admit')!(
      { conversationId: 'standalone:call-1', callId: 'call-1', targetUserId: 'invitee-1' },
      ack,
    )

    expect(assertMember).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('call.knock.admit still rejects a non-host for a standalone call', async () => {
    const { socket, handlers } = makeSocket('attacker')
    const { server } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: { getCallCreator: jest.fn().mockResolvedValue('real-host') },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock.admit')!(
      { conversationId: 'standalone:call-1', callId: 'call-1', targetUserId: 'invitee-1' },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })
})

describe('call.waiting.join', () => {
  it('lets a user wait on a standalone scheduled call without a Django membership record', async () => {
    const { socket, handlers } = makeSocket('guest-1')
    const { server } = makeServer()
    const assertMember = jest.fn().mockRejectedValue(new Error('Not a conversation member'))
    const setParticipantStatus = jest.fn()
    const deps = {
      djangoConversationClient: { assertMember },
      callsService: {
        getCall: jest.fn().mockResolvedValue({ status: 'pending', createdBy: 'host-1', callType: 'video', title: 'Sunday service' }),
        setParticipantStatus,
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.waiting.join')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(assertMember).not.toHaveBeenCalled()
    expect(setParticipantStatus).toHaveBeenCalledWith('standalone:call-1', 'call-1', 'guest-1', 'invited')
    expect(socket.join).toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('surfaces the waiting user in the host\'s existing admit/reject (knock) panel', async () => {
    const { socket, handlers } = makeSocket('guest-1')
    const { server, emitsByRoom } = makeServer()
    const addKnocker = jest.fn()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: {
        getCall: jest.fn().mockResolvedValue({ status: 'pending', createdBy: 'host-1' }),
        setParticipantStatus: jest.fn(),
        addKnocker,
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.waiting.join')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(addKnocker).toHaveBeenCalledWith('standalone:call-1', 'call-1', 'guest-1')
    const convEmit = emitsByRoom.get(require('../../chat/chat.types').rooms.convRoom('standalone:call-1'))
    expect(convEmit).toHaveBeenCalledWith(
      'call.knock.request',
      expect.objectContaining({ userId: 'guest-1', callId: 'call-1' }),
    )
  })

  it('rejects joining the waiting room for a call that no longer exists', async () => {
    const { socket, handlers } = makeSocket('guest-1')
    const { server } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: { getCall: jest.fn().mockResolvedValue(null) },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.waiting.join')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('rejects a user blocked by the standalone call creator', async () => {
    const { socket, handlers } = makeSocket('blocked-user')
    const { server } = makeServer()
    const checkBlockedAmong = jest.fn().mockResolvedValue(['host-1'])
    const deps = {
      djangoConversationClient: { assertMember: jest.fn(), checkBlockedAmong },
      callsService: { getCall: jest.fn().mockResolvedValue({ status: 'pending', createdBy: 'host-1' }) },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.waiting.join')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'BLOCKED' }))
  })

  // Same bug as call.answer (see calls.invite-link-answer.spec.ts): a
  // conversation-backed scheduled call someone made shareable via GET
  // /calls/join/:token must stay joinable in the waiting room by a
  // non-member who resolved it through that exact link — this used to
  // unconditionally throw on assertMember for any non-standalone
  // conversationId, with no invite-token check at all.
  it('lets a non-member wait on a conversation-backed call that has an active invite token', async () => {
    const { socket, handlers } = makeSocket('guest-1')
    const { server } = makeServer()
    const assertMember = jest.fn().mockRejectedValue(new Error('Not a conversation member'))
    const hasActiveInviteToken = jest.fn().mockResolvedValue(true)
    const setParticipantStatus = jest.fn()
    const deps = {
      djangoConversationClient: { assertMember },
      callsService: {
        getCall: jest.fn().mockResolvedValue({ status: 'pending', createdBy: 'host-1', callType: 'video', title: 'Sunday service' }),
        hasActiveInviteToken,
        setParticipantStatus,
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.waiting.join')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(hasActiveInviteToken).toHaveBeenCalledWith('conv-123', 'call-1')
    expect(setParticipantStatus).toHaveBeenCalledWith('conv-123', 'call-1', 'guest-1', 'invited')
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('still rejects a non-member for a conversation-backed call with NO invite token', async () => {
    const { socket, handlers } = makeSocket('guest-1')
    const { server } = makeServer()
    const assertMember = jest.fn().mockRejectedValue(new Error('Not a conversation member'))
    const deps = {
      djangoConversationClient: { assertMember },
      callsService: { hasActiveInviteToken: jest.fn().mockResolvedValue(false) },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.waiting.join')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('enforces the block check for an invite-link waiting-room joiner on a real conversation too', async () => {
    const { socket, handlers } = makeSocket('blocked-user')
    const { server } = makeServer()
    const checkBlockedAmong = jest.fn().mockResolvedValue(['host-1'])
    const deps = {
      djangoConversationClient: {
        assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
        checkBlockedAmong,
      },
      callsService: {
        getCall: jest.fn().mockResolvedValue({ status: 'pending', createdBy: 'host-1' }),
        hasActiveInviteToken: jest.fn().mockResolvedValue(true),
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.waiting.join')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(checkBlockedAmong).toHaveBeenCalledWith('blocked-user', ['host-1'])
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'BLOCKED' }))
  })
})

describe('call.knock.deny', () => {
  it('marks the denied participant status "rejected" so denial survives past the knock list', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server } = makeServer()
    const setParticipantStatus = jest.fn()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: {
        getCallCreator: jest.fn().mockResolvedValue('host-1'),
        removeKnocker: jest.fn(),
        setParticipantStatus,
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.knock.deny')!(
      { conversationId: 'standalone:call-1', callId: 'call-1', targetUserId: 'guest-1' },
      ack,
    )

    expect(setParticipantStatus).toHaveBeenCalledWith('standalone:call-1', 'call-1', 'guest-1', 'rejected', 'denied_by_host')
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })
})

describe('call.scheduled.start', () => {
  it('rejects a non-host trying to start someone else\'s scheduled call', async () => {
    const { socket, handlers } = makeSocket('attacker')
    const { server } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: { startScheduledCall: jest.fn().mockResolvedValue(null) },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.scheduled.start')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('starts the call for the real host and rings every stored invitee into the SAME callId', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server, emitsByRoom } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: {
        startScheduledCall: jest.fn().mockResolvedValue({
          callId: 'call-1',
          callType: 'video',
          media: 'video',
          title: 'Sunday service',
          participants: [{ userId: 'host-1' }, { userId: 'invitee-1' }],
        }),
      },
      notificationsService: { notifyIncomingCall: jest.fn().mockResolvedValue(undefined) },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.scheduled.start')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ callId: 'call-1', inviteeIds: ['invitee-1'] }),
    }))
    expect((deps.notificationsService as any).notifyIncomingCall).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 'invitee-1', callId: 'call-1' }),
    )
    const userRoomEmit = emitsByRoom.get(require('../../chat/chat.types').rooms.userRoom('invitee-1'))
    expect(userRoomEmit).toHaveBeenCalledWith('call.offer', expect.objectContaining({ callId: 'call-1' }))
  })

  it('never rings a participant the host already denied (status "rejected")', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server, emitsByRoom } = makeServer()
    const deps = {
      djangoConversationClient: { assertMember: jest.fn() },
      callsService: {
        startScheduledCall: jest.fn().mockResolvedValue({
          callId: 'call-1',
          callType: 'video',
          participants: [
            { userId: 'host-1' },
            { userId: 'denied-1', status: 'rejected' },
            { userId: 'invitee-1', status: 'invited' },
          ],
        }),
      },
    } as unknown as CallsDeps
    registerCallHandlers(server as any, socket, deps)
    const ack = jest.fn()

    await handlers.get('call.scheduled.start')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ inviteeIds: ['invitee-1'] }),
    }))
    const deniedUserRoomEmit = emitsByRoom.get(require('../../chat/chat.types').rooms.userRoom('denied-1'))
    expect(deniedUserRoomEmit).toBeUndefined()
  })
})
