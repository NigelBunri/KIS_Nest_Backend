// src/realtime/handlers/index.ts

import type { Server, Socket } from 'socket.io'

import { registerRoomHandlers, type RoomsDeps } from './rooms'
import { registerMessageHandlers, type MessagesDeps } from './messages'
import { registerReactionHandlers, type ReactionsDeps } from './reactions'
import { registerReceiptHandlers, type ReceiptsDeps } from './receipts'
import { registerTypingHandlers, type TypingDeps } from './typing'
import { registerSyncHandlers, type SyncDeps } from './sync'
import { registerCallHandlers, type CallsDeps } from './calls'
import { registerPinHandlers, type PinsDeps } from './pins'
import { registerLiveHandlers, type LiveDeps } from './live'
import { registerDisappearingHandlers, type DisappearingDeps } from './disappearing'
import { registerPollHandlers, type PollsDeps } from './polls'
import { registerGroupHandlers, type GroupsDeps } from './groups'
import { registerSfuHandlers, type SfuDeps } from './sfu'

const HANDLERS_REGISTERED_KEY = 'kisRealtimeHandlersRegistered'

/**
 * Aggregate dependency type for all realtime handlers.
 * CallsDeps now includes an optional notificationsService so the call handler
 * can send incoming-call push notifications to offline/backgrounded recipients.
 */
export type HandlersDeps =
  & RoomsDeps
  & MessagesDeps
  & ReactionsDeps
  & ReceiptsDeps
  & TypingDeps
  & SyncDeps
  & CallsDeps
  & PinsDeps
  & LiveDeps
  & DisappearingDeps
  & PollsDeps
  & GroupsDeps
  & SfuDeps

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
  if ((socket.data as Record<string, unknown>)[HANDLERS_REGISTERED_KEY]) {
    return
  }
  socket.data[HANDLERS_REGISTERED_KEY] = true

  registerRoomHandlers(server, socket, deps)
  registerMessageHandlers(server, socket, deps)
  registerReactionHandlers(server, socket, deps)
  registerReceiptHandlers(server, socket, deps)
  registerTypingHandlers(server, socket, deps)
  registerSyncHandlers(server, socket, deps)
  registerCallHandlers(server, socket, deps)
  registerPinHandlers(server, socket, deps)
  registerLiveHandlers(server, socket, deps)
  registerDisappearingHandlers(server, socket, deps)
  registerPollHandlers(server, socket, deps)
  registerGroupHandlers(server, socket, deps)
  registerSfuHandlers(server, socket, { sfuService: deps.sfuService, djangoConversationClient: deps.djangoConversationClient, rateLimitService: deps.rateLimitService })
}
