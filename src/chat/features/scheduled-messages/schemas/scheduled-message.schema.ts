// src/chat/features/scheduled-messages/schemas/scheduled-message.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type ScheduledMessageStatus = 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled'

export type ScheduledMessageDocument = HydratedDocument<ScheduledMessage>

/**
 * A message the user composed now but asked to be sent later. This is
 * deliberately NOT a row in the `messages` collection: Message.seq is
 * allocated once, atomically, from Django's authoritative per-conversation
 * counter and is relied on everywhere (ordering, pagination, unread-badge
 * math via last_message_seq) to mean "a message that genuinely exists right
 * now." Persisting a real Message early and only gating its broadcast (the
 * previous, broken design) would allocate that seq — and bump every
 * recipient's unread badge — the moment the message is scheduled, long
 * before anyone was supposed to see it, and would require every listing/
 * pagination/sync query in the app to grow an extra scheduledAt filter to
 * avoid leaking the pending content early. Keeping pending messages in their
 * own collection means the real Message, with a real seq, is only ever
 * created at actual delivery time — through the exact same
 * MessagesService.createIdempotent() + DjangoSeqClient.allocateSeq() path a
 * live EVT.SEND uses — so nothing downstream needs to know scheduling exists
 * at all.
 */
@Schema({ timestamps: true, writeConcern: { w: 'majority', wtimeout: 10_000 } })
export class ScheduledMessage {
  @Prop({ required: true, index: true })
  conversationId!: string

  @Prop({ required: true, index: true })
  senderId!: string

  @Prop()
  senderDeviceId?: string

  // Snapshot of the sender's display name at schedule time, for the push
  // notification fired at delivery time — avoids a Django round trip from
  // the cron just to resolve a name.
  @Prop()
  senderName?: string

  // Doubles as (a) the dedupe key for a retried "schedule this" submission
  // and (b) the clientId eventually passed to createIdempotent() at
  // delivery, so even a delivery retry can never create two real messages.
  @Prop({ required: true })
  clientId!: string

  // Opaque pass-through — identical shape to SendMessagePayload (text or
  // ciphertext+encryption metadata, attachments, kind, replyToId, etc.).
  // Whatever the client already composed/encrypted at schedule time is
  // replayed unchanged into the real send pipeline at delivery time; the
  // server never needs to interpret it beyond that pass-through.
  @Prop({ type: Object, required: true })
  payload!: Record<string, any>

  @Prop({ required: true, index: true })
  scheduledAt!: Date

  @Prop({
    required: true,
    default: 'scheduled',
    enum: ['scheduled', 'processing', 'sent', 'failed', 'cancelled'],
    index: true,
  })
  status!: ScheduledMessageStatus

  @Prop({ default: 0 })
  attempts!: number

  @Prop({ default: 5 })
  maxAttempts!: number

  // When this item next becomes eligible for a delivery attempt. Equals
  // scheduledAt until the first attempt; on a retriable failure it's pushed
  // forward by an exponential backoff.
  @Prop({ index: true })
  nextAttemptAt?: Date

  // Set when a worker claims this item (status -> 'processing'); used to
  // detect and recover items whose worker died mid-delivery.
  @Prop()
  processingStartedAt?: Date

  // Short, non-sensitive failure reason (never message content).
  @Prop()
  lastError?: string

  // Populated once delivered: the real Message's id/seq, so the UI can
  // link straight to it.
  @Prop()
  sentMessageId?: string

  @Prop()
  sentSeq?: number

  @Prop()
  cancelledAt?: Date

  createdAt!: Date
  updatedAt!: Date
}

export const ScheduledMessageSchema = SchemaFactory.createForClass(ScheduledMessage)

// Due-poll claim query (see ScheduledMessagesService.claimNextDue).
ScheduledMessageSchema.index({ status: 1, nextAttemptAt: 1 })

// Per-user pending list, sorted by scheduledAt ascending.
ScheduledMessageSchema.index({ senderId: 1, status: 1, scheduledAt: 1 })

// Idempotent re-submission guard (e.g. a retried "schedule" network call).
ScheduledMessageSchema.index({ conversationId: 1, clientId: 1 }, { unique: true })
