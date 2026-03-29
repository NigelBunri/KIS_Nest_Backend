import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ThreadDocument = HydratedDocument<Thread>;

@Schema({ timestamps: true })
export class Thread {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  rootMessageId!: string;

  @Prop({ required: true, index: true })
  createdBy!: string;

  @Prop()
  title?: string;

  // Optional for future: count, lastMessageAt, etc.
}

export const ThreadSchema = SchemaFactory.createForClass(Thread);

// One thread per root message in a conversation
ThreadSchema.index({ conversationId: 1, rootMessageId: 1 }, { unique: true });

// Fast list threads in a conversation
ThreadSchema.index({ conversationId: 1, createdAt: -1 });
