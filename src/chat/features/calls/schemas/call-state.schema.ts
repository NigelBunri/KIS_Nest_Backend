import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CallStateDocument = HydratedDocument<CallState>;

export type CallLifecycleState = 'ringing' | 'active' | 'ended' | 'missed';

@Schema({ timestamps: true })
export class CallState {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  callId!: string;

  @Prop({ required: true, index: true })
  fromUserId!: string;

  @Prop({ required: true, index: true })
  toUserId!: string;

  @Prop({ required: true, enum: ['ringing', 'active', 'ended', 'missed'] })
  state!: CallLifecycleState;

  @Prop({ min: 0 })
  startedAtMs?: number;

  @Prop({ min: 0 })
  endedAtMs?: number;

  @Prop()
  endedReason?: string;
}

export const CallStateSchema = SchemaFactory.createForClass(CallState);

// Unique per conversation + callId
CallStateSchema.index({ conversationId: 1, callId: 1 }, { unique: true });

// History queries
CallStateSchema.index({ conversationId: 1, createdAt: -1 });
CallStateSchema.index({ toUserId: 1, createdAt: -1 });
CallStateSchema.index({ fromUserId: 1, createdAt: -1 });
