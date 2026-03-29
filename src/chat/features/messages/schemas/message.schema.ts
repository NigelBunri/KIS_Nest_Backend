// src/chat/features/messages/schemas/message.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

/* ============================================================================
 * EMBEDDED TYPES (BATCH A)
 * ============================================================================
 */

@Schema({ _id: false })
class Attachment {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) url!: string;

  @Prop({ required: true }) originalName!: string;
  @Prop({ required: true }) mimeType!: string;
  @Prop({ required: true, min: 0 }) size!: number;

  @Prop() kind?: string;

  @Prop({ min: 0 }) width?: number;
  @Prop({ min: 0 }) height?: number;
  @Prop({ min: 0 }) durationMs?: number;
  @Prop() thumbUrl?: string;
}
const AttachmentSchema = SchemaFactory.createForClass(Attachment);

@Schema({ _id: false })
class StyledText {
  @Prop({ required: true }) text!: string;
  @Prop({ required: true }) backgroundColor!: string;
  @Prop({ required: true, min: 10, max: 120 }) fontSize!: number;
  @Prop({ required: true }) fontColor!: string;
  @Prop() fontFamily?: string;
}
const StyledTextSchema = SchemaFactory.createForClass(StyledText);

@Schema({ _id: false })
class VoiceMeta {
  @Prop({ required: true, min: 1 }) durationMs!: number;
}
const VoiceMetaSchema = SchemaFactory.createForClass(VoiceMeta);

@Schema({ _id: false })
class Sticker {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) uri!: string;
  @Prop() text?: string;
  @Prop({ min: 0 }) width?: number;
  @Prop({ min: 0 }) height?: number;
}
const StickerSchema = SchemaFactory.createForClass(Sticker);

@Schema({ _id: false })
class ContactCard {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) name!: string;
  @Prop({ required: true }) phone!: string;
}
const ContactCardSchema = SchemaFactory.createForClass(ContactCard);

@Schema({ _id: false })
class PollOption {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) text!: string;
  @Prop({ min: 0 }) votes?: number;
}
const PollOptionSchema = SchemaFactory.createForClass(PollOption);

@Schema({ _id: false })
class Poll {
  @Prop() id?: string;
  @Prop({ required: true }) question!: string;
  @Prop({ type: [PollOptionSchema], default: [] }) options!: PollOption[];
  @Prop() allowMultiple?: boolean;

  // ✅ Avoid union ambiguity in @nestjs/mongoose
  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;
}
const PollSchema = SchemaFactory.createForClass(Poll);

@Schema({ _id: false })
class EventPayload {
  @Prop() id?: string;
  @Prop({ required: true }) title!: string;
  @Prop() description?: string;
  @Prop() location?: string;
  @Prop({ required: true }) startsAt!: string;
  @Prop() endsAt?: string;
  @Prop({ min: 0 }) reminderMinutes?: number;
}
const EventPayloadSchema = SchemaFactory.createForClass(EventPayload);

/* ============================================================================
 * LEGACY TYPES (needed by receipts/reactions/sync)
 * ============================================================================
 */

@Schema({ _id: false })
export class ReactionEntry {
  @Prop({ required: true }) userId!: string;
  @Prop({ required: true }) emoji!: string;
  @Prop({ required: true }) at!: number;
}
export const ReactionEntrySchema = SchemaFactory.createForClass(ReactionEntry);

@Schema({ _id: false })
export class ReceiptEntry {
  @Prop({ required: true }) userId!: string;
  @Prop({ required: true }) deviceId!: string;
  @Prop({ required: true }) atMs!: number;
}
export const ReceiptEntrySchema = SchemaFactory.createForClass(ReceiptEntry);

@Schema({ _id: false })
class Ephemeral {
  @Prop({ default: false }) enabled!: boolean;
  @Prop({ default: false }) startAfterRead!: boolean;
  @Prop({ min: 1 }) ttlSeconds?: number;
  @Prop({ min: 0 }) expireAt?: number;
}
const EphemeralSchema = SchemaFactory.createForClass(Ephemeral);

/* ============================================================================
 * MESSAGE
 * ============================================================================
 */

export type MessageKind =
  | 'text'
  | 'voice'
  | 'styled_text'
  | 'sticker'
  | 'system'
  | 'contacts'
  | 'poll'
  | 'event';

@Schema({ timestamps: true })
export class Message {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  senderId!: string;

  // Client dedupe key (offline-first)
  @Prop({ required: true })
  clientId!: string;

  // Sequence allocated by Django (authoritative ordering)
  @Prop({ required: true, index: true })
  seq!: number;

  @Prop({
    required: true,
    enum: ['text', 'voice', 'styled_text', 'sticker', 'system', 'contacts', 'poll', 'event'],
  })
  kind!: MessageKind;

  /* ----- Batch B: Threads wiring ----- */
  @Prop({ index: true })
  threadId?: string;

  /* ----- Batch A fields ----- */

  @Prop()
  text?: string;

  @Prop({ type: StyledTextSchema })
  styledText?: StyledText;

  @Prop({ type: VoiceMetaSchema })
  voice?: VoiceMeta;

  @Prop({ type: StickerSchema })
  sticker?: Sticker;

  @Prop({ type: [AttachmentSchema], default: undefined })
  attachments?: Attachment[];

  @Prop({ type: [ContactCardSchema], default: undefined })
  contacts?: ContactCard[];

  @Prop({ type: PollSchema })
  poll?: Poll;

  @Prop({ type: EventPayloadSchema })
  event?: EventPayload;

  @Prop()
  replyToId?: string;

  @Prop({ default: false })
  isEdited!: boolean;

  @Prop({ default: false })
  isDeleted!: boolean;

  // Optional: denormalized preview string for conversation lists
  @Prop()
  previewText?: string;

  /* ----- Legacy compatibility fields (keep existing services compiling) ----- */

  @Prop()
  senderDeviceId?: string;

  @Prop()
  ciphertext?: string;

  @Prop({ type: Object })
  encryptionMeta?: Record<string, any>;

  @Prop({ type: [ReactionEntrySchema], default: [] })
  reactions!: ReactionEntry[];

  @Prop({ type: [ReceiptEntrySchema], default: [] })
  deliveredTo!: ReceiptEntry[];

  @Prop({ type: [ReceiptEntrySchema], default: [] })
  readBy!: ReceiptEntry[];

  @Prop({ type: [ReceiptEntrySchema], default: [] })
  playedBy!: ReceiptEntry[];

  @Prop({ type: EphemeralSchema })
  ephemeral?: Ephemeral;

  @Prop()
  deleteState?: 'deleted_for_me' | 'deleted_for_everyone';

  @Prop({ min: 0 })
  deletedAt?: number;

  @Prop()
  deletedBy?: string;

  @Prop({ min: 0 })
  editedAt?: number;

  // Timestamp typing (mongoose timestamps option)
  createdAt!: Date;
  updatedAt!: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// ---- Indexes ----

// Strict ordering queries
MessageSchema.index({ conversationId: 1, seq: 1 }, { unique: true });

// Idempotency: avoid duplicate messages on retries/reconnect flush
MessageSchema.index({ conversationId: 1, clientId: 1 }, { unique: true });

// Common sort/filter
MessageSchema.index({ conversationId: 1, createdAt: -1 });

// ✅ Threads timeline queries
MessageSchema.index({ conversationId: 1, threadId: 1, seq: 1 });
MessageSchema.index({ conversationId: 1, threadId: 1, createdAt: -1 });

// ✅ Full-text search
MessageSchema.index(
  { text: 'text', previewText: 'text' },
  { weights: { text: 10, previewText: 3 }, name: 'MessageTextSearch' },
);
