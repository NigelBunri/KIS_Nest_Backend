import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'

@Schema({ timestamps: true, versionKey: false })
export class FeedPost {
  @Prop({ required: true })
  tenantId!: string

  @Prop({ required: true })
  authorId!: string

  @Prop({ default: '' })
  text!: string

  @Prop({ type: Array, default: [] })
  attachments!: any[]

  @Prop()
  communityId?: string

  @Prop()
  partnerProfileId?: string

  @Prop()
  channelMessageId?: string

  @Prop()
  sourceConversationId?: string

  @Prop({ default: false })
  isDeleted!: boolean

  @Prop()
  deletedAt?: Date
}

export type FeedPostDocument = FeedPost & Document<Types.ObjectId>

export const FeedPostSchema = SchemaFactory.createForClass(FeedPost)
FeedPostSchema.index({ tenantId: 1, createdAt: -1 })
FeedPostSchema.index({ authorId: 1, createdAt: -1 })
