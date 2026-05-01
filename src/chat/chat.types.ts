// src/chat/chat.types.ts

/* =========================
 * Message Kinds (Canonical)
 * ========================= */

export enum MessageKind {
  TEXT = 'text',
  STYLED_TEXT = 'styled_text',
  VOICE = 'voice',
  STICKER = 'sticker',
  SYSTEM = 'system',
  CONTACTS = 'contacts',
  POLL = 'poll',
  EVENT = 'event',
}

/**
 * Use this when you want the string-literal union of enum values.
 * Example: kind: MessageKindValue
 */
export type MessageKindValue = `${MessageKind}`;

/**
 * Use this for validation lists (class-validator IsIn).
 */
export const MESSAGE_KINDS = Object.values(MessageKind) as MessageKindValue[];

/* =========================
 * Socket Principal & Auth
 * ========================= */

export interface SocketPrincipal {
  userId: string
  username?: string
  deviceId?: string
  scopes?: string[]
  token?: string
}

export const BROADCAST_CONVERSATION_PREFIX = 'broadcast:';

export const isBroadcastConversation = (conversationId?: string | null) =>
  typeof conversationId === 'string' && conversationId.startsWith(BROADCAST_CONVERSATION_PREFIX);

/* =========================
 * Conversation Permissions
 * ========================= */

export type ConversationPermission =
  | 'read'
  | 'write'
  | 'react'
  | 'moderate'
  | 'admin'

/* =========================
 * Rooms helpers
 * ========================= */

export const rooms = {
  userRoom: (userId: string) => `user:${userId}`,
  convRoom: (conversationId: string) => `conv:${conversationId}`,
  threadRoom: (threadId: string) => `thread:${threadId}`,
}

/* =========================
 * Event Names (WS Contract)
 * ========================= */

export const EVT = {
  // lifecycle
  JOIN: 'chat.join',
  LEAVE: 'chat.leave',

  // messaging
  SEND: 'chat.send',
  EDIT: 'chat.edit',
  DELETE: 'chat.delete',
  MESSAGE: 'chat.message',
  HISTORY: 'chat.history',

  // reactions & receipts
  REACT: 'chat.react',
  MESSAGE_REACTION: 'chat.message_reaction',

  RECEIPT: 'chat.receipt',
  MESSAGE_RECEIPT: 'chat.message_receipt',

  // typing
  TYPING: 'chat.typing',

  // sync / gap repair
  GAP_CHECK: 'chat.gap_check',
  GAP_FILL: 'chat.gap_fill',

  // presence
  PRESENCE: 'chat.presence',

  // pins & stars
  PIN_SET: 'chat.pin_set',
  STAR_SET: 'chat.star_set',

  // calls (signaling)
  CALL_OFFER: 'call.offer',
  CALL_ANSWER: 'call.answer',
  CALL_ICE: 'call.ice',
  CALL_END: 'call.end',
} as const

export type EventKey = (typeof EVT)[keyof typeof EVT]

/* =========================
 * Rich Payload Types
 * ========================= */

export interface AttachmentPayload {
  id?: string
  url: string
  name?: string
  mime?: string
  originalName?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
}

export interface StyledTextPayload {
  text: string
  entities?: Array<{
    type: 'bold' | 'italic' | 'underline' | 'code' | 'link'
    offset: number
    length: number
    url?: string
  }>
}

export interface VoicePayload {
  url: string
  durationMs: number
  waveform?: number[]
}

export interface StickerPayload {
  id: string
  pack?: string
}

export interface ContactPayload {
  name: string
  phone?: string
  email?: string
}

export interface PollOption {
  id: string
  label: string
  votes?: number
}

export interface PollPayload {
  question: string
  options: PollOption[]
  multiple?: boolean
  expiresAt?: Date | null
}

export interface EventPayload {
  title: string
  description?: string
  startsAt?: Date
  endsAt?: Date
}

/* =========================
 * Send / Edit Payloads
 * ========================= */

export interface SendMessagePayload {
  conversationId: string
  clientId: string

  /**
   * Keep enum type for code ergonomics (MessageKind.TEXT, etc.).
   * In DTO validation you can use MessageKindValue + MESSAGE_KINDS.
   */
  kind: MessageKind

  text?: string
  styledText?: StyledTextPayload
  attachments?: AttachmentPayload[]
  voice?: VoicePayload
  sticker?: StickerPayload
  contacts?: ContactPayload[]
  poll?: PollPayload
  event?: EventPayload

  threadId?: string
  replyTo?: string
  ephemeral?: boolean

  encrypted?: boolean
  ciphertext?: string
  encryptionMeta?: Record<string, any>
  iv?: string
  tag?: string
  encryptionVersion?: string
  encryptionKeyVersion?: string
  aad?: string
}

export interface EditMessagePayload {
  conversationId: string
  messageId: string
  text?: string
  encrypted?: boolean
  ciphertext?: string
  encryptionMeta?: Record<string, any>
  iv?: string
  tag?: string
  encryptionVersion?: string
  encryptionKeyVersion?: string
  aad?: string
  styledText?: StyledTextPayload
}

/* =========================
 * Reactions & Receipts
 * ========================= */

export interface ReactionPayload {
  conversationId: string
  messageId: string
  emoji: string
}

export type ReceiptType = 'delivered' | 'read' | 'played'

export interface ReceiptPayload {
  conversationId: string
  messageId: string
  type: ReceiptType
}

/* =========================
 * Sync / Gap Repair
 * ========================= */

export interface GapCheckPayload {
  conversationId: string
  haveSeqs: number[]
}

export interface GapFillPayload {
  conversationId: string
  missingSeqs: number[]
}

export interface HistoryPayload {
  conversationId: string
  limit?: number
  before?: string
  after?: string
}

/* =========================
 * Acknowledgements
 * ========================= */

export interface AckOk<T = any> {
  ok: true
  data: T
}

export interface AckErr {
  ok: false
  error: string
  code?: string
}

export type Ack<T = any> = AckOk<T> | AckErr

export interface SendMessageAck {
  clientId: string
  serverId: string
  seq: number
  createdAt: string
}
