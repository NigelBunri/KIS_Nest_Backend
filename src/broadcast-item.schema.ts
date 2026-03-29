import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'
import { BroadcastSourceType, BroadcastVertical, BroadcastVisibility } from './broadcast.types'
import type { BroadcastEngagement } from './broadcast.types'

@Schema({ timestamps: true, versionKey: false })
export class BroadcastItem {
  @Prop({ required: true })
  tenantId!: string

  @Prop({ required: true })
  creatorId!: string

  @Prop({ required: true, enum: BroadcastVertical })
  vertical!: BroadcastVertical

  @Prop({ required: true, enum: BroadcastSourceType })
  sourceType!: BroadcastSourceType

  @Prop({ required: true })
  sourceId!: string

  @Prop({ enum: BroadcastVisibility, default: BroadcastVisibility.PUBLIC })
  visibility!: BroadcastVisibility

  @Prop()
  title?: string

  @Prop()
  body?: string

  @Prop({ type: Array, default: [] })
  attachments?: any[]

  @Prop({ type: Object, default: () => ({}) })
  metadata!: Record<string, unknown>

  @Prop({ type: String, default: null })
  idempotencyKey?: string | null

  @Prop({ default: () => new Date() })
  broadcastedAt!: Date

  @Prop({
    type: Object,
    default: () =>
      ({
        reactions: 0,
        comments: 0,
        shares: 0,
        saves: 0,
      } as BroadcastEngagement),
  })
  engagement!: BroadcastEngagement

  @Prop({ default: false })
  isDeleted!: boolean

  @Prop()
  deletedAt?: Date
}

export type BroadcastItemDocument = BroadcastItem & Document<Types.ObjectId>

export const BroadcastItemSchema = SchemaFactory.createForClass(BroadcastItem)
BroadcastItemSchema.index({ tenantId: 1, vertical: 1, broadcastedAt: -1, _id: -1 })
BroadcastItemSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true, $ne: null } } },
)
