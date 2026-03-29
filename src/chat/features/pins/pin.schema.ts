import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PinDocument = HydratedDocument<Pin>;

@Schema({ timestamps: true })
export class Pin {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  messageId!: string;

  @Prop({ required: true, index: true })
  pinnedBy!: string;
}

export const PinSchema = SchemaFactory.createForClass(Pin);

// One pin record per conversation per message
PinSchema.index({ conversationId: 1, messageId: 1 }, { unique: true });

// Fast list pinned messages per conversation
PinSchema.index({ conversationId: 1, createdAt: -1 });
