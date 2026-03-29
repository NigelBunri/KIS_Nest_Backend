import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type ConversationKeyDocument = HydratedDocument<ConversationKey>

@Schema({ timestamps: true })
export class ConversationKey {
  @Prop({ required: true, unique: true })
  conversationId!: string

  @Prop({ required: true })
  key!: string

  @Prop({ required: true })
  version!: string
}

export const ConversationKeySchema = SchemaFactory.createForClass(ConversationKey)
