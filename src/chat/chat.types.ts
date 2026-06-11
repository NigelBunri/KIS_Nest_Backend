// src/chat/chat.types.ts

/* =========================
 * Message Kinds (Canonical)
 * ========================= */

export enum MessageKind {
  TEXT = 'text',
  ATTACHMENT = 'attachment',
  STYLED_TEXT = 'styled_text',
  VOICE = 'voice',
  STICKER = 'sticker',
  SYSTEM = 'system',
  CONTACTS = 'contacts',
  POLL = 'poll',
  EVENT = 'event',
  LOCATION = 'location',
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
  CONVERSATION_UPDATED: 'conversation.updated',
  MAIN_TAB_BADGES_UPDATED: 'main_tab_badges.updated',

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

  // calls — legacy signaling (1:1, keep for backwards compat)
  CALL_OFFER: 'call.offer',
  CALL_ANSWER: 'call.answer',
  CALL_ICE: 'call.ice',
  CALL_END: 'call.end',

  // calls — WebRTC peer-to-peer media negotiation (targeted relay)
  CALL_SDP_OFFER: 'call.sdp.offer',
  CALL_SDP_ANSWER: 'call.sdp.answer',
  CALL_ICE_CANDIDATE: 'call.ice.candidate',

  // calls — participant lifecycle (server → clients)
  CALL_PARTICIPANT_JOINED: 'call.participant.joined',
  CALL_PARTICIPANT_LEFT: 'call.participant.left',
  CALL_PARTICIPANT_MUTED: 'call.participant.muted',

  // calls — group & broadcast features
  CALL_HAND_RAISE: 'call.hand.raise',
  CALL_HAND_LOWER: 'call.hand.lower',
  CALL_REACTION: 'call.reaction',
  CALL_CHAT_MSG: 'call.chat.message',

  // calls — host controls
  CALL_PARTICIPANT_MUTE: 'call.participant.mute',
  CALL_PARTICIPANT_REMOVE: 'call.participant.remove',

  // calls — broadcast stats
  CALL_VIEWER_COUNT: 'call.viewer.count',

  // live location
  LOCATION_UPDATE: 'chat.location_update',

  // view-once acknowledgement (recipient tells server they opened it)
  VIEW_ONCE: 'chat.view_once',

  // fetch which messages the current user has starred in a conversation
  GET_STARRED: 'chat.get_starred',

  // GAP 9: group invite link regeneration
  GROUP_REGENERATE_INVITE: 'group.regenerate_invite',

  // GAP 13: extended activity sub-states (recording, location sharing)
  ACTIVITY: 'chat.activity',

  // GAP 20: thread subject update
  THREAD_UPDATE_SUBJECT: 'thread.update_subject',

  // GAP 26: user preference sync
  USER_SYNC_PREFERENCE: 'user.sync_preference',
  USER_GET_PREFERENCE: 'user.get_preference',

  // GAP 1: screen sharing in calls
  CALL_SCREEN_SHARE: 'call.screen_share',

  // GAP 4: payment messages
  PAYMENT_ACCEPT: 'payment.accept',
  PAYMENT_DECLINE: 'payment.decline',

  // GAP 5: multi-device session management
  USER_GET_DEVICES: 'user.get_devices',
  USER_REMOVE_DEVICE: 'user.remove_device',
} as const

export type EventKey = (typeof EVT)[keyof typeof EVT]

/* =========================
 * Rich Payload Types
 * ========================= */

export interface AttachmentPayload {
  publicUrl?: string
  downloadUrl?: string
  displayUrl?: string
  assetId?: string
  mediaAssetId?: string
  mediaAssetRef?: string
  kind?: string
  thumbUrl?: string
  private?: boolean
  scanStatus?: string
  quarantined?: boolean
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
  // Visual style fields — must match message.schema.ts StyledText and frontend chatTypes.ts
  backgroundColor?: string
  fontSize?: number
  fontColor?: string
  fontFamily?: string
  // Inline entity markup (bold/italic/etc.)
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

export interface LocationPayload {
  latitude: number
  longitude: number
  address?: string
  title?: string
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
  previewText?: string
  styledText?: StyledTextPayload
  attachments?: AttachmentPayload[]
  media?: {
    attachments?: AttachmentPayload[]
    [key: string]: any
  }
  voice?: VoicePayload
  sticker?: StickerPayload
  contacts?: ContactPayload[]
  poll?: PollPayload
  event?: EventPayload
  location?: LocationPayload

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
  diagnostics?: Record<string, any>
}

export type Ack<T = any> = AckOk<T> | AckErr

export interface SendMessageAck {
  clientId: string
  serverId: string
  seq: number
  createdAt: string
}
