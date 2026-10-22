// src/realtime/handlers/live.ts

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'
import { getPrincipal, safeEmit } from './utils'
import { rooms } from '../../chat/chat.types'

const logger = new Logger('ChatLiveHandlers')

export interface LiveDeps {
  djangoConversationClient: {
    canViewLiveStream(userId: string, streamId: string): Promise<boolean>
    reportViewerCount(streamId: string, count: number): Promise<void>
  }
  rateLimitService?: {
    assert(principal: { userId: string }, key: string, limit?: number): Promise<void> | void
  }
}

// Reasonable emoji-burst set for D6 (live reactions) - capped so a client
// can't smuggle an arbitrary string through this event; mirrors how
// call.reaction (calls.ts) is itself a free-text emoji field but, unlike
// that 1:1/small-group call context, a live stream's room can have
// thousands of members, so an allowlist is the safer default here.
const ALLOWED_LIVE_REACTIONS = new Set(['❤️', '🔥', '👏', '😂', '😮', '🙏'])

/**
 * Register live-stream socket handlers.
 *
 * channel.live.join  { streamId: string }  — viewer opened live stream
 * channel.live.leave { streamId: string }  — viewer closed live stream
 *
 * On join/leave, broadcasts channel.viewer.count to all viewers of that stream.
 * On disconnect, cleans up all live rooms and broadcasts updated counts.
 */
export function registerLiveHandlers(
  server: Server,
  socket: Socket,
  deps: LiveDeps,
) {
  const streamRoom = rooms.streamRoom

  async function broadcastViewerCount(streamId: string): Promise<void> {
    const room = streamRoom(streamId)
    try {
      const sockets = await server.in(room).fetchSockets()
      const count = sockets.length
      safeEmit(server, room, 'channel.viewer.count', { streamId, count })
      logger.debug(`[live] stream=${streamId} viewers=${count}`)
      // Fire-and-forget - never let a slow/unreachable Django delay the
      // broadcast viewers just received.
      void deps.djangoConversationClient.reportViewerCount(streamId, count)
    } catch (err: any) {
      logger.warn(`[live] broadcastViewerCount error: ${err?.message}`)
    }
  }

  socket.on('channel.live.join', async (payload: any, ack?: (a: any) => void) => {
    const streamId = typeof payload?.streamId === 'string' ? payload.streamId.trim() : ''
    if (!streamId) return
    const principal = getPrincipal(socket)
    try {
      // Re-verify against Django the same way status.join re-verifies
      // canViewStatus - without this, any authenticated socket could join
      // a private channel's live-stream room by guessing/leaking a
      // streamId and observe its viewer count / live chat broadcast even
      // though the REST live-stream endpoint 404s them. Fails closed (an
      // unreachable Django denies the join) because canViewLiveStream
      // itself fails closed.
      const canView = await deps.djangoConversationClient.canViewLiveStream(principal.userId, streamId)
      if (!canView) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Stream not found' })
        return
      }
    } catch (error: any) {
      logger.warn(`[live] canViewLiveStream check failed streamId=${streamId}: ${error?.message}`)
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not join stream' })
      return
    }
    logger.debug(`[live] join streamId=${streamId} userId=${principal?.userId}`)
    socket.join(streamRoom(streamId))
    await broadcastViewerCount(streamId)
    if (typeof ack === 'function') ack({ ok: true, joined: true, streamId })
  })

  socket.on('channel.live.leave', async (payload: any) => {
    const streamId = typeof payload?.streamId === 'string' ? payload.streamId.trim() : ''
    if (!streamId) return
    const principal = getPrincipal(socket)
    logger.debug(`[live] leave streamId=${streamId} userId=${principal?.userId}`)
    socket.leave(streamRoom(streamId))
    await broadcastViewerCount(streamId)
  })

  // channel.live.reaction — D6 of the YouTube-parity batch: an ephemeral
  // emoji burst (tap-to-send, floats up and disappears client-side), not a
  // persisted row - these are high-frequency and have no analytics value
  // this codebase's ChannelAnalyticsDailyRollup rolls up elsewhere (unlike
  // chat messages, tips, or polls, which all persist because they have
  // lasting value - a moderator needs chat history, a creator needs tip
  // records; nobody needs a history of exactly who hearted which second).
  // No separate canViewLiveStream re-check here: a socket can only reach
  // this room by already having passed that check in channel.live.join
  // above, and leave/disconnect remove it from the room - reusing the
  // existing room membership as the authorization boundary avoids a
  // network round-trip to Django on every single reaction tap, which
  // channel.live.join's one-time check per session does not need to pay.
  socket.on('channel.live.reaction', async (payload: any, ack?: (a: any) => void) => {
    const streamId = typeof payload?.streamId === 'string' ? payload.streamId.trim() : ''
    const emoji = typeof payload?.emoji === 'string' ? payload.emoji.trim() : ''
    if (!streamId || !ALLOWED_LIVE_REACTIONS.has(emoji)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Invalid reaction' })
      return
    }
    const principal = getPrincipal(socket)
    const room = streamRoom(streamId)
    if (!socket.rooms.has(room)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Not watching this stream' })
      return
    }
    try {
      await deps.rateLimitService?.assert(principal, 'live:reaction', 30)
    } catch (error: any) {
      if (typeof ack === 'function') ack({ ok: false, error: error?.message ?? 'Too many reactions', code: 'RATE_LIMITED' })
      return
    }
    safeEmit(server, room, 'channel.live.reaction', {
      streamId,
      emoji,
      userId: principal.userId,
      sentAt: new Date().toISOString(),
    })
    if (typeof ack === 'function') ack({ ok: true })
  })

  // On disconnect, leave all live stream rooms and broadcast updated counts
  socket.on('disconnect', async () => {
    const joinedRooms = Array.from(socket.rooms)
    const streamIds = joinedRooms
      .filter(r => r.startsWith('stream:'))
      .map(r => r.slice(7)) // remove 'stream:' prefix

    for (const streamId of streamIds) {
      // socket has already left rooms on disconnect — count will be correct.
      // Reuses broadcastViewerCount (not a second inline copy) so the
      // Django viewer-count report never gets missed on this path.
      await broadcastViewerCount(streamId)
    }
  })
}
