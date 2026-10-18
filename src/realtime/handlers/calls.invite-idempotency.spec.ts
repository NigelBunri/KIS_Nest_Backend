import { registerCallHandlers, CallsDeps } from './calls'

// Regression coverage for the "add a participant mid-call" bug audit:
// call.invite (the socket handler behind the in-call "Add" button /
// SocketProvider.inviteToCall) previously had no idempotency guard at all —
// repeated taps, or a client retry, re-sent a full CALL_OFFER + a second
// VoIP/incoming-call push for the same callId/uid every time, and
// unconditionally reset the invitee's participant row to 'invited' even if
// they had already joined (setParticipantStatus has no transition guard of
// its own). It also never reset the call's own stale-ringing-timeout clock,
// so a contact invited late in an otherwise-stale ring window could be
// auto-missed by cleanupStaleCalls seconds after being invited (see
// calls.service.staleness.spec.ts's lastInviteAt tests for that half).

function makeSocket(userId = 'host-1') {
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
      getCall: jest.fn().mockResolvedValue({
        callId: 'call-1',
        conversationId: 'conv-1',
        status: 'active',
        callType: 'video-group',
        title: 'Team call',
        participants: [{ userId: 'host-1', status: 'joined' }],
      }),
      setParticipantStatus: jest.fn(),
      touchLastInviteAt: jest.fn(),
    },
    notificationsService: {
      notifyIncomingCall: jest.fn().mockResolvedValue(undefined),
      notifyMissedCall: jest.fn(),
    },
    ...overrides,
  } as CallsDeps
}

describe('call.invite idempotency and stale-state guards', () => {
  it('invites a genuinely new participant: pushes CALL_OFFER, sends a push, and bumps lastInviteAt', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps()
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.invite')!(
      { conversationId: 'conv-1', callId: 'call-1', inviteeUserIds: ['new-user'] },
      ack,
    )

    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-1', 'call-1', 'new-user', 'invited', undefined, false,
    )
    expect((deps.callsService as any).touchLastInviteAt).toHaveBeenCalledWith('conv-1', 'call-1')
    expect(emitsByRoom.get('user:new-user')).toBeDefined()
    expect((deps.notificationsService as any).notifyIncomingCall).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 'new-user' }),
    )
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({ invitedCount: 1 }) }))
  })

  it('does NOT re-ring or reset an already-JOINED participant — repeated invite is a safe no-op for them', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          callId: 'call-1',
          conversationId: 'conv-1',
          status: 'active',
          callType: 'video-group',
          participants: [
            { userId: 'host-1', status: 'joined' },
            { userId: 'already-joined', status: 'joined' },
          ],
        }),
        setParticipantStatus: jest.fn(),
        touchLastInviteAt: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.invite')!(
      { conversationId: 'conv-1', callId: 'call-1', inviteeUserIds: ['already-joined'] },
      ack,
    )

    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
    expect((deps.callsService as any).touchLastInviteAt).not.toHaveBeenCalled()
    expect(emitsByRoom.get('user:already-joined')).toBeUndefined()
    expect((deps.notificationsService as any).notifyIncomingCall).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({ invitedCount: 0 }) }))
  })

  it('does NOT re-ring someone already in the "invited" state (double-tap on Add) — no duplicate ringing', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          callId: 'call-1',
          conversationId: 'conv-1',
          status: 'active',
          callType: 'video-group',
          participants: [
            { userId: 'host-1', status: 'joined' },
            { userId: 'mid-ring', status: 'invited' },
          ],
        }),
        setParticipantStatus: jest.fn(),
        touchLastInviteAt: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.invite')!(
      { conversationId: 'conv-1', callId: 'call-1', inviteeUserIds: ['mid-ring'] },
      ack,
    )

    expect(emitsByRoom.get('user:mid-ring')).toBeUndefined()
    expect((deps.notificationsService as any).notifyIncomingCall).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({ invitedCount: 0 }) }))
  })

  it('invites fresh users while skipping already-resolved ones in the same batch', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server, emitsByRoom } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          callId: 'call-1',
          conversationId: 'conv-1',
          status: 'active',
          callType: 'video-group',
          participants: [
            { userId: 'host-1', status: 'joined' },
            { userId: 'already-joined', status: 'joined' },
          ],
        }),
        setParticipantStatus: jest.fn(),
        touchLastInviteAt: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.invite')!(
      { conversationId: 'conv-1', callId: 'call-1', inviteeUserIds: ['already-joined', 'brand-new'] },
      ack,
    )

    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledTimes(1)
    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-1', 'call-1', 'brand-new', 'invited', undefined, false,
    )
    expect(emitsByRoom.get('user:already-joined')).toBeUndefined()
    expect(emitsByRoom.get('user:brand-new')).toBeDefined()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({ invitedCount: 1 }) }))
  })

  it('rejects inviting onto a call that has already ended', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          callId: 'call-1',
          conversationId: 'conv-1',
          status: 'ended',
          participants: [],
        }),
        setParticipantStatus: jest.fn(),
        touchLastInviteAt: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.invite')!(
      { conversationId: 'conv-1', callId: 'call-1', inviteeUserIds: ['someone'] },
      ack,
    )

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'CALL_ENDED' }))
    expect((deps.callsService as any).setParticipantStatus).not.toHaveBeenCalled()
  })

  it('invites a new user onto a broadcast as a panelist, not a bare participant', async () => {
    const { socket, handlers } = makeSocket('host-1')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        getCall: jest.fn().mockResolvedValue({
          callId: 'call-1',
          conversationId: 'conv-1',
          status: 'active',
          callType: 'broadcast',
          participants: [{ userId: 'host-1', status: 'joined' }],
        }),
        setParticipantStatus: jest.fn(),
        touchLastInviteAt: jest.fn(),
      } as any,
    })
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.invite')!(
      { conversationId: 'conv-1', callId: 'call-1', inviteeUserIds: ['new-panelist'] },
      ack,
    )

    expect((deps.callsService as any).setParticipantStatus).toHaveBeenCalledWith(
      'conv-1', 'call-1', 'new-panelist', 'invited', undefined, true,
    )
  })
})
