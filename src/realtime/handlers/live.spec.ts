import { registerLiveHandlers } from './live'
import { rooms } from '../../chat/chat.types'

// channel.live.join re-verifies via DjangoConversationClient.canViewLiveStream
// before joining the stream's viewer-count/live-chat-broadcast room - the
// same pattern statusDiscussions.ts's status.join uses for canViewStatus.
// Without it, any authenticated socket could join a private channel's live
// stream room by guessing/leaking a streamId.

function makeDjangoClient(canView = true) {
  return {
    canViewLiveStream: jest.fn().mockResolvedValue(canView),
    reportViewerCount: jest.fn().mockResolvedValue(undefined),
  }
}

function makeSocket(userId = 'viewer-1', joinedRooms: string[] = []) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId, token: 'jwt' },
    rooms: new Set(joinedRooms),
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler)
    }),
    join: jest.fn((room: string) => socket.rooms.add(room)),
    leave: jest.fn((room: string) => socket.rooms.delete(room)),
  }
  return { socket, handlers }
}

function makeServer(socketsByRoom: Record<string, unknown[]> = {}) {
  const emit = jest.fn()
  const server: any = {
    in: jest.fn((room: string) => ({
      fetchSockets: jest.fn().mockResolvedValue(socketsByRoom[room] ?? []),
    })),
    to: jest.fn(() => ({ emit })),
  }
  return { server, emit }
}

describe('channel.live.join / channel.live.leave / disconnect', () => {
  it('joins the stream room and broadcasts the current viewer count', async () => {
    const { socket, handlers } = makeSocket('viewer-1')
    const room = rooms.streamRoom('stream-1')
    const { server, emit } = makeServer({ [room]: [{}, {}] })
    const djangoConversationClient = makeDjangoClient(true)
    registerLiveHandlers(server, socket, { djangoConversationClient })

    const ack = jest.fn()
    await handlers.get('channel.live.join')!({ streamId: 'stream-1' }, ack)

    expect(djangoConversationClient.canViewLiveStream).toHaveBeenCalledWith('viewer-1', 'stream-1')
    expect(socket.join).toHaveBeenCalledWith(room)
    expect(server.to).toHaveBeenCalledWith(room)
    expect(emit).toHaveBeenCalledWith('channel.viewer.count', { streamId: 'stream-1', count: 2 })
    expect(ack).toHaveBeenCalledWith({ ok: true, joined: true, streamId: 'stream-1' })
    // Django's peak_viewer_count tracking folds this exact socket-room count
    // in via LiveStreamViewerCountReportView - must fire on every count
    // broadcast, not just be a client-side-only number.
    expect(djangoConversationClient.reportViewerCount).toHaveBeenCalledWith('stream-1', 2)
  })

  it('reports the viewer count to Django even when a socket disconnects without an explicit leave', async () => {
    const { socket, handlers } = makeSocket('viewer-1', [rooms.streamRoom('stream-1')])
    const room = rooms.streamRoom('stream-1')
    const { server } = makeServer({ [room]: [{}] })
    const djangoConversationClient = makeDjangoClient(true)
    registerLiveHandlers(server, socket, { djangoConversationClient })

    await handlers.get('disconnect')!()

    expect(djangoConversationClient.reportViewerCount).toHaveBeenCalledWith('stream-1', 1)
  })

  it('ignores a join with no streamId without touching the socket, server, or Django', async () => {
    const { socket, handlers } = makeSocket()
    const { server } = makeServer()
    const djangoConversationClient = makeDjangoClient(true)
    registerLiveHandlers(server, socket, { djangoConversationClient })

    await handlers.get('channel.live.join')!({})

    expect(socket.join).not.toHaveBeenCalled()
    expect(server.in).not.toHaveBeenCalled()
    expect(djangoConversationClient.canViewLiveStream).not.toHaveBeenCalled()
  })

  it('refuses to join a stream the user cannot view, and does not broadcast a count', async () => {
    const { socket, handlers } = makeSocket('viewer-1')
    const room = rooms.streamRoom('stream-1')
    const { server, emit } = makeServer({ [room]: [{}, {}] })
    const djangoConversationClient = makeDjangoClient(false)
    registerLiveHandlers(server, socket, { djangoConversationClient })

    const ack = jest.fn()
    await handlers.get('channel.live.join')!({ streamId: 'stream-1' }, ack)

    expect(socket.join).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Stream not found' })
  })

  it('refuses to join when Django is unreachable (canViewLiveStream fails closed)', async () => {
    const { socket, handlers } = makeSocket('viewer-1')
    const { server, emit } = makeServer()
    const djangoConversationClient = {
      canViewLiveStream: jest.fn().mockRejectedValue(new Error('django unreachable')),
      reportViewerCount: jest.fn().mockResolvedValue(undefined),
    }
    registerLiveHandlers(server, socket, { djangoConversationClient })

    const ack = jest.fn()
    await handlers.get('channel.live.join')!({ streamId: 'stream-1' }, ack)

    expect(socket.join).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Could not join stream' })
  })

  it('leaves the stream room and broadcasts the updated viewer count', async () => {
    const room = rooms.streamRoom('stream-1')
    const { socket, handlers } = makeSocket('viewer-1', [room])
    const { server, emit } = makeServer({ [room]: [{}] })
    registerLiveHandlers(server, socket, { djangoConversationClient: makeDjangoClient(true) })

    await handlers.get('channel.live.leave')!({ streamId: 'stream-1' })

    expect(socket.leave).toHaveBeenCalledWith(room)
    expect(emit).toHaveBeenCalledWith('channel.viewer.count', { streamId: 'stream-1', count: 1 })
  })

  it('on disconnect, broadcasts an updated count for every stream room the socket had joined', async () => {
    const roomA = rooms.streamRoom('stream-a')
    const roomB = rooms.streamRoom('stream-b')
    const { socket, handlers } = makeSocket('viewer-1', [roomA, roomB, 'user:viewer-1'])
    const { server, emit } = makeServer({ [roomA]: [{}], [roomB]: [] })
    registerLiveHandlers(server, socket, { djangoConversationClient: makeDjangoClient(true) })

    await handlers.get('disconnect')!()

    expect(emit).toHaveBeenCalledWith('channel.viewer.count', { streamId: 'stream-a', count: 1 })
    expect(emit).toHaveBeenCalledWith('channel.viewer.count', { streamId: 'stream-b', count: 0 })
    expect(emit).not.toHaveBeenCalledWith('channel.viewer.count', expect.objectContaining({ streamId: 'viewer-1' }))
  })

  it('swallows fetchSockets errors instead of throwing', async () => {
    const { socket, handlers } = makeSocket('viewer-1')
    const server: any = {
      in: jest.fn(() => ({ fetchSockets: jest.fn().mockRejectedValue(new Error('redis down')) })),
      to: jest.fn(() => ({ emit: jest.fn() })),
    }
    registerLiveHandlers(server, socket, { djangoConversationClient: makeDjangoClient(true) })

    await expect(handlers.get('channel.live.join')!({ streamId: 'stream-1' })).resolves.toBeUndefined()
  })
})

// D6 of the YouTube-parity batch: channel.live.reaction is an ephemeral
// emoji burst - no persistence, authorized by the socket already being in
// the stream room (set by a prior channel.live.join, which itself already
// re-verified canViewLiveStream), rate-limited per user.
describe('channel.live.reaction', () => {
  function makeRateLimit(shouldThrow = false) {
    return {
      assert: shouldThrow
        ? jest.fn().mockRejectedValue(new Error('Too many reactions'))
        : jest.fn().mockResolvedValue(undefined),
    }
  }

  it('broadcasts an allowed reaction to everyone in the stream room', async () => {
    const room = rooms.streamRoom('stream-1')
    const { socket, handlers } = makeSocket('viewer-1', [room])
    const { server, emit } = makeServer()
    const rateLimitService = makeRateLimit()
    registerLiveHandlers(server, socket, { djangoConversationClient: makeDjangoClient(true), rateLimitService })

    const ack = jest.fn()
    await handlers.get('channel.live.reaction')!({ streamId: 'stream-1', emoji: '❤️' }, ack)

    expect(rateLimitService.assert).toHaveBeenCalledWith({ userId: 'viewer-1', token: 'jwt' }, 'live:reaction', 30)
    expect(server.to).toHaveBeenCalledWith(room)
    expect(emit).toHaveBeenCalledWith('channel.live.reaction', expect.objectContaining({
      streamId: 'stream-1', emoji: '❤️', userId: 'viewer-1',
    }))
    expect(ack).toHaveBeenCalledWith({ ok: true })
  })

  it('rejects a reaction from a socket not in the stream room, without broadcasting', async () => {
    const { socket, handlers } = makeSocket('viewer-1', [])
    const { server, emit } = makeServer()
    registerLiveHandlers(server, socket, { djangoConversationClient: makeDjangoClient(true), rateLimitService: makeRateLimit() })

    const ack = jest.fn()
    await handlers.get('channel.live.reaction')!({ streamId: 'stream-1', emoji: '❤️' }, ack)

    expect(emit).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Not watching this stream' })
  })

  it('rejects an emoji outside the allowed set', async () => {
    const room = rooms.streamRoom('stream-1')
    const { socket, handlers } = makeSocket('viewer-1', [room])
    const { server, emit } = makeServer()
    registerLiveHandlers(server, socket, { djangoConversationClient: makeDjangoClient(true), rateLimitService: makeRateLimit() })

    const ack = jest.fn()
    await handlers.get('channel.live.reaction')!({ streamId: 'stream-1', emoji: '💀' }, ack)

    expect(emit).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Invalid reaction' })
  })

  it('rejects when the per-user rate limit is exceeded', async () => {
    const room = rooms.streamRoom('stream-1')
    const { socket, handlers } = makeSocket('viewer-1', [room])
    const { server, emit } = makeServer()
    registerLiveHandlers(server, socket, { djangoConversationClient: makeDjangoClient(true), rateLimitService: makeRateLimit(true) })

    const ack = jest.fn()
    await handlers.get('channel.live.reaction')!({ streamId: 'stream-1', emoji: '❤️' }, ack)

    expect(emit).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Too many reactions', code: 'RATE_LIMITED' })
  })
})
