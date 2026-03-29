import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document } from 'mongoose'

@Schema({ timestamps: true, versionKey: false })
export class BroadcastReaction {
  @Prop({ required: true })
  broadcastItemId!: string

  @Prop({ required: true })
  userId!: string

  @Prop({ required: true })
  type!: string
}

export type BroadcastReactionDocument = BroadcastReaction & Document

export const BroadcastReactionSchema = SchemaFactory.createForClass(BroadcastReaction)
BroadcastReactionSchema.index(
  { broadcastItemId: 1, userId: 1, type: 1 },
  { unique: true },
)
