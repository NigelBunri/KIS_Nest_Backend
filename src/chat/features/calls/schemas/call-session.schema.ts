import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CallSessionDocument = CallSession & Document;

export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'pending';
export type CallParticipantStatus =
  | 'invited'
  | 'connecting'
  | 'joined'
  | 'left'
  | 'rejected'
  | 'busy';

export type CallSignalKind = 'offer' | 'answer' | 'ice' | 'renegotiate' | 'hangup';

export type CallParticipantRole = 'host' | 'co-host' | 'speaker' | 'audience';

@Schema({ _id: false })
export class CallParticipant {
  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true, enum: ['invited', 'connecting', 'joined', 'left', 'rejected', 'busy'] })
  status!: CallParticipantStatus;

  @Prop({ type: String, default: null, enum: ['host', 'co-host', 'speaker', 'audience', null] })
  role!: CallParticipantRole | null;

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

  @Prop({ type: String, required: true, enum: ['ringing', 'active', 'ended', 'missed', 'pending'], index: true })
  status!: CallStatus;

  @Prop({ type: Date, required: true, index: true })
  startedAt!: Date;

  @Prop({ type: Date, default: null })
  endedAt!: Date | null;

  // Legacy 2-value field kept for backwards compat
  @Prop({ type: String, default: 'voice' })
  media!: string;

  // Full 5-type call classification
  @Prop({ type: String, default: 'voice', enum: ['voice', 'video', 'voice-group', 'video-group', 'broadcast'], index: true })
  callType!: string;

  // Broadcast live viewer count (non-participant viewers)
  @Prop({ type: Number, default: 0 })
  viewerCount!: number;

  // participants snapshot (small arrays, bounded)
  @Prop({ type: [Object], default: [] })
  participants!: CallParticipant[];

  // lightweight audit trail; keep bounded
  @Prop({ type: [Object], default: [] })
  signals!: CallSignalEvent[];

  // used for “only one active call per conversation” gating
  @Prop({ type: Boolean, default: false, index: true })
  isActiveInConversation!: boolean;

  // Standalone calls — not tied to an existing DM/group conversation
  @Prop({ type: Boolean, default: false })
  isStandalone!: boolean;

  // Human-readable title for standalone/scheduled calls
  @Prop({ type: String, default: null })
  title!: string | null;

  // Invite link token — unique random string for join-by-link flow
  @Prop({ type: String, default: null })
  inviteToken!: string | null;

  // Scheduled start time (null = start immediately)
  @Prop({ type: Date, default: null })
  scheduledFor!: Date | null;

  // Users currently knocking to join (broadcast/locked calls)
  @Prop({ type: [String], default: [] })
  knockingUserIds!: string[];

  // Recording state
  @Prop({ type: String, default: 'idle', enum: ['idle', 'recording', 'stopped'] })
  recordingState!: 'idle' | 'recording' | 'stopped';

  @Prop({ type: String, default: null })
  recordingUrl!: string | null;

  // RTMP streaming URL (for broadcast live-stream out)
  @Prop({ type: String, default: null })
  rtmpUrl!: string | null;

  @Prop({ type: Boolean, default: false })
  rtmpActive!: boolean;
}

export const CallSessionSchema = SchemaFactory.createForClass(CallSession);

// Ensure only one active call per conversation (best-effort)
CallSessionSchema.index(
  { conversationId: 1, isActiveInConversation: 1 },
  { unique: true, partialFilterExpression: { isActiveInConversation: true } },
);

// Fast lookup
CallSessionSchema.index({ conversationId: 1, callId: 1 }, { unique: true });

// Unique invite token for join-by-link
CallSessionSchema.index({ inviteToken: 1 }, { unique: true, sparse: true });

// Scheduled call discovery
CallSessionSchema.index({ scheduledFor: 1, status: 1 }, { sparse: true });

// Cleanup / queries
CallSessionSchema.index({ conversationId: 1, status: 1, startedAt: -1 });
CallSessionSchema.index({ endedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14, partialFilterExpression: { endedAt: { $type: 'date' } } });
// TTL: keep ended calls 14 days; tune as needed.
