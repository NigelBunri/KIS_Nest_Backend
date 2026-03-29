import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CallSessionDocument = CallSession & Document;

export type CallStatus = 'ringing' | 'active' | 'ended';
export type CallParticipantStatus =
  | 'invited'
  | 'connecting'
  | 'joined'
  | 'left'
  | 'rejected'
  | 'busy';

export type CallSignalKind = 'offer' | 'answer' | 'ice' | 'renegotiate' | 'hangup';

@Schema({ _id: false })
export class CallParticipant {
  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true, enum: ['invited', 'connecting', 'joined', 'left', 'rejected', 'busy'] })
  status!: CallParticipantStatus;

  @Prop({ type: Date, default: null })
  invitedAt!: Date | null;

  @Prop({ type: Date, default: null })
  joinedAt!: Date | null;

  @Prop({ type: Date, default: null })
  leftAt!: Date | null;

  @Prop({ type: String, default: null })
  reason!: string | null;
}

@Schema({ _id: false })
export class CallSignalEvent {
  @Prop({ type: String, required: true, enum: ['offer', 'answer', 'ice', 'renegotiate', 'hangup'] })
  kind!: CallSignalKind;

  @Prop({ type: String, required: true })
  fromUserId!: string;

  @Prop({ type: String, default: null })
  toUserId!: string | null;

  @Prop({ type: String, default: null })
  payloadType!: string | null; // e.g. "sdp", "candidate", "bye"

  @Prop({ type: Date, required: true })
  createdAt!: Date;
}

@Schema({ timestamps: true })
export class CallSession {
  @Prop({ type: String, required: true, index: true })
  conversationId!: string;

  // client-generated unique id for the call (uuid). Also used for room/thread naming if you want later.
  @Prop({ type: String, required: true, index: true })
  callId!: string;

  @Prop({ type: String, required: true })
  createdBy!: string;

  @Prop({ type: String, required: true, enum: ['ringing', 'active', 'ended'], index: true })
  status!: CallStatus;

  @Prop({ type: Date, required: true, index: true })
  startedAt!: Date;

  @Prop({ type: Date, default: null, index: true })
  endedAt!: Date | null;

  // Optional: "voice" | "video" (or whatever your clients send)
  @Prop({ type: String, default: 'voice' })
  media!: string;

  // participants snapshot (small arrays, bounded)
  @Prop({ type: [Object], default: [] })
  participants!: CallParticipant[];

  // lightweight audit trail; keep bounded
  @Prop({ type: [Object], default: [] })
  signals!: CallSignalEvent[];

  // used for “only one active call per conversation” gating
  @Prop({ type: Boolean, default: false, index: true })
  isActiveInConversation!: boolean;
}

export const CallSessionSchema = SchemaFactory.createForClass(CallSession);

// Ensure only one active call per conversation (best-effort)
CallSessionSchema.index(
  { conversationId: 1, isActiveInConversation: 1 },
  { unique: true, partialFilterExpression: { isActiveInConversation: true } },
);

// Fast lookup
CallSessionSchema.index({ conversationId: 1, callId: 1 }, { unique: true });

// Cleanup / queries
CallSessionSchema.index({ conversationId: 1, status: 1, startedAt: -1 });
CallSessionSchema.index({ endedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14, partialFilterExpression: { endedAt: { $type: 'date' } } });
// TTL: keep ended calls 14 days; tune as needed.
