import { ChatGateway } from './chat.gateway'

// Focused unit test of the stale-disconnect guard added for
// KIS_CALLING_BACKGROUND_LIFECYCLE_AUDIT.md finding #3: a disconnect-grace
// timer must never be (re)armed for a user who already has a newer, live
// socket connection by the time the disconnect is actually processed, and
// any pending timer must be proactively cancelled on every new connection —
// not only when the client itself gets around to sending call.sync.
//
// ChatGateway is instantiated directly (bypassing Nest's DI container,
// mirroring calls.service.spec.ts's `new CallsService({} as any)` pattern)
// since handleConnection/handleDisconnect only touch a handful of the
// constructor's ~18 injected services; the rest are passed as empty stubs
// they never call.

function makeGateway(overrides: { callsService?: any; presenceService?: any } = {}) {
  const callsService = overrides.callsService ?? {
    getActiveCallsForUser: jest.fn().mockResolvedValue([]),
    scheduleDisconnectGrace: jest.fn(),
    cancelDisconnectGrace: jest.fn(),
  }
  const presenceService = overrides.presenceService ?? {
    markOnline: jest.fn().mockResolvedValue(undefined),
    markOffline: jest.fn().mockResolvedValue(undefined),
  }

  const gateway = new ChatGateway(
    {} as any, // djangoConversationClient
    {} as any, // scheduledMessagesCron
    {} as any, // djangoSeqClient
    {} as any, // rateLimitService
    {} as any, // messagesService
    {} as any, // reactionsService
    {} as any, // receiptsService
    {} as any, // syncService
    callsService as any,
    {} as any, // moderationService
    presenceService as any,
    {} as any, // notificationsService
    {} as any, // authService
    {} as any, // pinsService
    {} as any, // starsService
    {} as any, // threadsService
    {} as any, // sfuService
  )

  const emit = jest.fn()
  const to = jest.fn(() => ({ emit }))
  const fetchSockets = jest.fn().mockResolvedValue([])
  const inFn = jest.fn(() => ({ fetchSockets }))
  ;(gateway as any).server = { to, in: inFn, emit }

  return { gateway, callsService, presenceService, to, emit, inFn, fetchSockets }
}

function makeSocket(userId: string, rooms: string[] = []) {
  return {
    id: `socket-${Math.random().toString(36).slice(2)}`,
    principal: { userId },
    rooms: new Set(rooms),
    data: {},
    removeAllListeners: jest.fn(),
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn(),
    disconnect: jest.fn(),
    conn: { transport: { name: 'websocket' } },
    nsp: { name: '/ws' },
    handshake: { auth: {}, headers: {}, address: '127.0.0.1' },
  } as any
}

describe('ChatGateway disconnect-grace connection-awareness', () => {
  it('schedules the grace timer on disconnect when the user has no other live connection (preserves existing behavior)', async () => {
    const call = { conversationId: 'conv-1', callId: 'call-1' }
    const { gateway, callsService, fetchSockets } = makeGateway({
      callsService: {
        getActiveCallsForUser: jest.fn().mockResolvedValue([call]),
        scheduleDisconnectGrace: jest.fn(),
        cancelDisconnectGrace: jest.fn(),
      },
    })
    fetchSockets.mockResolvedValue([]) // no other socket for this user

    const socket = makeSocket('user-1')
    await gateway.handleDisconnect(socket)

    expect(callsService.scheduleDisconnectGrace).toHaveBeenCalledTimes(1)
    expect(callsService.scheduleDisconnectGrace).toHaveBeenCalledWith(
      'conv-1',
      'call-1',
      'user-1',
      expect.any(Function),
    )
  })

  it('does NOT schedule a grace timer when a newer connection for the same user is already live (stale disconnect)', async () => {
    const call = { conversationId: 'conv-1', callId: 'call-1' }
    const { gateway, callsService, fetchSockets } = makeGateway({
      callsService: {
        getActiveCallsForUser: jest.fn().mockResolvedValue([call]),
        scheduleDisconnectGrace: jest.fn(),
        cancelDisconnectGrace: jest.fn(),
      },
    })
    // A different, still-connected socket for this user is in the room —
    // this disconnect is the "zombie" socket's late notification.
    fetchSockets.mockResolvedValue([{ id: 'socket-newer' }])

    const socket = makeSocket('user-1')
    await gateway.handleDisconnect(socket)

    expect(callsService.scheduleDisconnectGrace).not.toHaveBeenCalled()
    expect(callsService.getActiveCallsForUser).not.toHaveBeenCalled()
  })

  it('proactively cancels pending grace timers for every active call on a new connection', async () => {
    const calls = [
      { conversationId: 'conv-1', callId: 'call-1' },
      { conversationId: 'conv-2', callId: 'call-2' },
    ]
    const { gateway, callsService } = makeGateway({
      callsService: {
        getActiveCallsForUser: jest.fn().mockResolvedValue(calls),
        scheduleDisconnectGrace: jest.fn(),
        cancelDisconnectGrace: jest.fn(),
      },
    })

    const socket = makeSocket('user-1')
    await gateway.handleConnection(socket)
    // cancelDisconnectGrace is kicked off fire-and-forget (.then(...)) in
    // handleConnection, not awaited — flush the microtask queue once.
    await new Promise((resolve) => setImmediate(resolve))

    expect(callsService.cancelDisconnectGrace).toHaveBeenCalledWith('conv-1', 'call-1', 'user-1')
    expect(callsService.cancelDisconnectGrace).toHaveBeenCalledWith('conv-2', 'call-2', 'user-1')
  })

  it('a reconnect race is handled correctly end to end: stale old-socket disconnect is ignored once the new socket already connected', async () => {
    const call = { conversationId: 'conv-1', callId: 'call-1' }
    const callsService = {
      getActiveCallsForUser: jest.fn().mockResolvedValue([call]),
      scheduleDisconnectGrace: jest.fn(),
      cancelDisconnectGrace: jest.fn(),
    }
    const { gateway, fetchSockets } = makeGateway({ callsService })

    // Step 1: the new socket (B) connects and proactively cancels any
    // pending timer (none pending yet — fine, cancelDisconnectGrace is a
    // no-op in that case in the real implementation).
    const socketB = makeSocket('user-1')
    fetchSockets.mockResolvedValue([]) // not relevant to handleConnection
    await gateway.handleConnection(socketB)
    await new Promise((resolve) => setImmediate(resolve))
    expect(callsService.cancelDisconnectGrace).toHaveBeenCalledWith('conv-1', 'call-1', 'user-1')

    // Step 2: the OLD, now-stale socket (A) finally has its disconnect
    // processed by the server. By this point socket B is already live, so
    // fetchSockets() on the user room returns it.
    fetchSockets.mockResolvedValue([{ id: socketB.id }])
    const socketA = makeSocket('user-1')
    await gateway.handleDisconnect(socketA)

    // The stale disconnect must NOT schedule a fresh grace timer — nothing
    // is left to cancel it, which is exactly the bug this guard closes.
    expect(callsService.scheduleDisconnectGrace).not.toHaveBeenCalled()
  })
})
