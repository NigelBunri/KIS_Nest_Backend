import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReportDocument = HydratedDocument<MessageReport>;
export type BlockDocument = HydratedDocument<ConversationBlock>;
export type MuteDocument = HydratedDocument<ConversationMute>;

@Schema({ timestamps: true })
export class MessageReport {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  messageId!: string;

  @Prop({ required: true, index: true })
  reportedBy!: string;

  @Prop()
  reason?: string;

  @Prop()
  note?: string;
}
export const MessageReportSchema = SchemaFactory.createForClass(MessageReport);
MessageReportSchema.index({ conversationId: 1, messageId: 1, reportedBy: 1 }, { unique: true });

@Schema({ timestamps: true })
export class ConversationBlock {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true })
  blocked!: boolean;
}
export const ConversationBlockSchema = SchemaFactory.createForClass(ConversationBlock);
ConversationBlockSchema.index({ conversationId: 1, userId: 1 }, { unique: true });

@Schema({ timestamps: true })
export class ConversationMute {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true })
  muted!: boolean;

  @Prop({ min: 0 })
  untilMs?: number;
}
export const ConversationMuteSchema = SchemaFactory.createForClass(ConversationMute);
ConversationMuteSchema.index({ conversationId: 1, userId: 1 }, { unique: true });
