import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type BroadcastConversationDocument = HydratedDocument<BroadcastConversation>

@Schema({ timestamps: true })
export class BroadcastConversation {
  @Prop({ required: true, index: true, unique: true })
  broadcastId!: string

  @Prop({ required: true, index: true, unique: true })
  conversationId!: string

  @Prop({ required: true })
  title!: string
}

export const BroadcastConversationSchema =
  SchemaFactory.createForClass(BroadcastConversation)
