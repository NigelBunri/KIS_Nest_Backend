// src/realtime/handlers/utils.ts

import type { Server, Socket } from 'socket.io'
import type { Ack, AckErr, AckOk, SocketPrincipal } from '../../chat/chat.types'

export type AnyAckFn = (ack: Ack<any>) => void

export function ok<T>(data: T): AckOk<T> {
  return { ok: true, data }
}

export function err(message: string, code?: string): AckErr {
  return { ok: false, error: message, code }
}

export function safeAck<T>(ack: AnyAckFn | undefined, payload: Ack<T>) {
  try {
    if (typeof ack === 'function') ack(payload)
  } catch {
    // never throw from ack path
  }
}

export function getPrincipal(socket: Socket): SocketPrincipal {
  const p = (socket as any).principal as SocketPrincipal | undefined
  if (!p?.userId) throw new Error('Missing socket principal')
  return p
}

export function safeEmit(server: Server, room: string, event: string, payload: any) {
  try {
    server.to(room).emit(event, payload)
  } catch {
    // never throw from emit path
  }
}
