// src/realtime/handlers/live.ts

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'
import { getPrincipal, safeEmit } from './utils'

const logger = new Logger('ChatLiveHandlers')

export interface LiveDeps {
  // No external deps needed — viewer count is tracked via socket room membership
}

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
  _deps: LiveDeps,
) {
  const streamRoom = (streamId: string) => `stream:${streamId}`

  async function broadcastViewerCount(streamId: string): Promise<void> {
    const room = streamRoom(streamId)
    try {
      const sockets = await server.in(room).fetchSockets()
      const count = sockets.length
      safeEmit(server, room, 'channel.viewer.count', { streamId, count })
      logger.debug(`[live] stream=${streamId} viewers=${count}`)
    } catch (err: any) {
      logger.warn(`[live] broadcastViewerCount error: ${err?.message}`)
    }
  }

  socket.on('channel.live.join', async (payload: any) => {
    const streamId = typeof payload?.streamId === 'string' ? payload.streamId.trim() : ''
    if (!streamId) return
    const principal = getPrincipal(socket)
    logger.debug(`[live] join streamId=${streamId} userId=${principal?.userId}`)
    socket.join(streamRoom(streamId))
    await broadcastViewerCount(streamId)
  })

  socket.on('channel.live.leave', async (payload: any) => {
    const streamId = typeof payload?.streamId === 'string' ? payload.streamId.trim() : ''
    if (!streamId) return
    const principal = getPrincipal(socket)
    logger.debug(`[live] leave streamId=${streamId} userId=${principal?.userId}`)
    socket.leave(streamRoom(streamId))
    await broadcastViewerCount(streamId)
  })

  // On disconnect, leave all live stream rooms and broadcast updated counts
  socket.on('disconnect', async () => {
    const joinedRooms = Array.from(socket.rooms)
    const streamIds = joinedRooms
      .filter(r => r.startsWith('stream:'))
      .map(r => r.slice(7)) // remove 'stream:' prefix

    for (const streamId of streamIds) {
      // socket has already left rooms on disconnect — count will be correct
      try {
        const room = streamRoom(streamId)
        const sockets = await server.in(room).fetchSockets()
        const count = sockets.length
        safeEmit(server, room, 'channel.viewer.count', { streamId, count })
      } catch {}
    }
  })
}
