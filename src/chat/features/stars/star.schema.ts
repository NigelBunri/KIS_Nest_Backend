import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StarDocument = HydratedDocument<Star>;

@Schema({ timestamps: true })
export class Star {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  messageId!: string;
}

export const StarSchema = SchemaFactory.createForClass(Star);

// One star per user per message
StarSchema.index({ userId: 1, conversationId: 1, messageId: 1 }, { unique: true });

// Fast list queries
StarSchema.index({ userId: 1, conversationId: 1, createdAt: -1 });
