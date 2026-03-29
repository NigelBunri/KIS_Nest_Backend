// src/realtime/handlers/index.ts

import type { Server, Socket } from 'socket.io'

import { registerRoomHandlers, type RoomsDeps } from './rooms'
import { registerMessageHandlers, type MessagesDeps } from './messages'
import { registerReactionHandlers, type ReactionsDeps } from './reactions'
import { registerReceiptHandlers, type ReceiptsDeps } from './receipts'
import { registerTypingHandlers, type TypingDeps } from './typing'
import { registerSyncHandlers, type SyncDeps } from './sync'
import { registerCallHandlers, type CallsDeps } from './calls'

/**
 * Aggregate dependency type for all realtime handlers
 */
export type HandlersDeps =
  & RoomsDeps
  & MessagesDeps
  & ReactionsDeps
  & ReceiptsDeps
  & TypingDeps
  & SyncDeps
  & CallsDeps

/**
 * Register all realtime socket handlers on a connected socket
 *
 * Called once per socket connection from ChatGateway
 */
export function registerRealtimeHandlers(
  server: Server,
  socket: Socket,
  deps: HandlersDeps,
) {
  registerRoomHandlers(server, socket, deps)
  registerMessageHandlers(server, socket, deps)
  registerReactionHandlers(server, socket, deps)
  registerReceiptHandlers(server, socket, deps)
  registerTypingHandlers(server, socket, deps)
  registerSyncHandlers(server, socket, deps)
  registerCallHandlers(server, socket, deps)
}
