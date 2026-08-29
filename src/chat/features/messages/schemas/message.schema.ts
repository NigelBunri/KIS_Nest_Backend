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
  /** Stable, client-facing identity (UUID). NEVER the raw storage key. */
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) url!: string;

  /**
   * Real storage-provider object key (S3 key or local path key), used only
   * server-side to resolve fresh presigned URLs / stream bytes. Absent on
   * attachments persisted before this field existed — those legacy rows
   * fall back to treating `id` as the key (see AttachmentAccessService).
   */
  @Prop() storageKey?: string;

  @Prop({ required: true }) originalName!: string;
  @Prop({ required: true }) mimeType!: string;
  @Prop({ required: true, min: 0 }) size!: number;

  @Prop() kind?: string;

  @Prop({ min: 0 }) width?: number;
  @Prop({ min: 0 }) height?: number;
  @Prop({ min: 0 }) durationMs?: number;
  @Prop() thumbUrl?: string;

  /** UTC timestamp when the S3 file will be / has been deleted (10 days after upload). */
  @Prop({ type: Date }) expiresAt?: Date;
  /** Set to true after the S3 file has been deleted by the cleanup job. */
  @Prop({ default: false }) expired?: boolean;

  /** View-once: recipient can view this media exactly once before it auto-deletes */
  @Prop({ default: false }) viewOnce?: boolean;
  /** ISO timestamp when the recipient first opened this view-once attachment */
  @Prop() viewedAt?: string;

  /** Media-safety / moderation state, carried through from upload confirmation. */
  @Prop() scanStatus?: string;
  @Prop({ default: false }) quarantined?: boolean;
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

  // Canonical voice-attachment metadata — previously ONLY durationMs was
  // declared here, so Mongoose subdocument casting silently stripped
  // voice.url (and everything else) from every message the instant it
  // saved, regardless of what the client sent. That made every voice note
  // unplayable for receivers (who only ever read the persisted document)
  // and, intermittently, for senders too. All optional for backward
  // compatibility with rows already persisted before this field existed —
  // see requestVoiceMediaUrl-style refresh logic on the RN side, which
  // must tolerate an absent url on old messages.
  @Prop() id?: string;
  @Prop() url?: string;
  /** Django MediaAsset.id — the permanent identity used to refresh an
   * expired url (see voice-playback.service.ts). NOT a raw storage key. */
  @Prop() mediaAssetId?: string;
  /** Display/back-compat only, mirrors Attachment.storageKey — Django never
   * returns the real S3 key to a client, so this is not a trustworthy key. */
  @Prop() objectKey?: string;
  @Prop() originalName?: string;
  @Prop() mimeType?: string;
  @Prop({ min: 0 }) size?: number;
  @Prop({ type: [Number], default: undefined }) waveform?: number[];
  @Prop() urlExpiresAt?: string;
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
  @Prop({ type: [String], default: [] }) voters?: string[];
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

@Schema({ _id: false })
class LocationCoords {
  @Prop({ required: true }) latitude!: number;
  @Prop({ required: true }) longitude!: number;
  @Prop() address?: string;
  @Prop() title?: string;
}
const LocationCoordsSchema = SchemaFactory.createForClass(LocationCoords);

@Schema({ _id: false })
class BibleVerse {
  // Canonical "Book chapter:verseStart[-verseEnd]" string - what the
  // receiving client's Bible screen actually navigates to (see
  // src/utils/bibleReference.ts on the frontend).
  @Prop({ required: true }) reference!: string;
  @Prop() bookCode?: string;
  @Prop() bookName?: string;
  @Prop({ required: true }) chapter!: number;
  @Prop() verseStart?: number;
  @Prop() verseEnd?: number;
  // Verse text snapshot for the chat preview card - the receiver can read
  // it inline without opening the Bible screen.
  @Prop() text?: string;
}
const BibleVerseSchema = SchemaFactory.createForClass(BibleVerse);

@Schema({ _id: false })
class LinkPreview {
  @Prop() url?: string;
  @Prop() title?: string;
  @Prop() description?: string;
  @Prop() image?: string;
  @Prop() site_name?: string;
}
const LinkPreviewSchema = SchemaFactory.createForClass(LinkPreview);

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
  | 'attachment'
  | 'voice'
  | 'styled_text'
  | 'sticker'
  | 'system'
  | 'contacts'
  | 'poll'
  | 'event'
  | 'location'
  | 'call_event'
  | 'bible_verse';

@Schema({
  timestamps: true,
  writeConcern: { w: 'majority', wtimeout: 10_000 },
})
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
    enum: ['text', 'attachment', 'voice', 'styled_text', 'sticker', 'system', 'contacts', 'poll', 'event', 'location', 'call_event', 'bible_verse'],
  })
  kind!: MessageKind;

  // Populated only when kind === 'call_event'
  @Prop({ type: Object })
  callEvent?: {
    callId: string;
    callType: string;
    status: 'completed' | 'missed' | 'cancelled';
    duration?: number | null; // seconds
    participantCount?: number;
    initiatedBy?: string;
  };

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

  @Prop({ type: Object, default: undefined })
  media?: Record<string, any>;

  @Prop({ type: [ContactCardSchema], default: undefined })
  contacts?: ContactCard[];

  @Prop({ type: PollSchema })
  poll?: Poll;

  @Prop({ type: EventPayloadSchema })
  event?: EventPayload;

  @Prop({ type: LocationCoordsSchema })
  location?: LocationCoords;

  @Prop({ type: BibleVerseSchema })
  bibleVerse?: BibleVerse;

  @Prop({ type: LinkPreviewSchema })
  linkPreview?: LinkPreview;

  @Prop()
  replyToId?: string;

  @Prop({ default: false })
  isEdited!: boolean;

  @Prop({ default: false })
  isDeleted!: boolean;

  /** Message-level view-once (text, voice, or attachments together - the
   * whole message is either view-once or it isn't, no per-part
   * granularity). Set true by the sender's original payload only when
   * unencrypted; for E2EE sends this stays false at creation and is set
   * here only by markViewOnceOpened, purely as a "this was view-once and
   * has now been consumed" record - see that method's docstring. */
  @Prop({ default: false })
  viewOnce?: boolean;

  /** ISO timestamp set once a recipient opens a view-once message. Presence
   * (not just viewOnce) is what markViewOnceOpened / the chat.view_once
   * handler treat as "already consumed" for idempotency. */
  @Prop()
  viewedAt?: string;

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

  @Prop()
  iv?: string;

  @Prop()
  tag?: string;

  @Prop()
  aad?: string;

  @Prop()
  encryptionVersion?: string;

  @Prop()
  encryptionKeyVersion?: string;

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

  // Scheduled message fields
  @Prop({ type: Date })
  scheduledAt?: Date;

  @Prop({ default: false })
  scheduledDelivered!: boolean;

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

// Scheduled message delivery poll
MessageSchema.index({ scheduledAt: 1, scheduledDelivered: 1, isDeleted: 1 });
