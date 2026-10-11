// ARCHIVED/LEGACY (2026-10-04): feature-flagged off everywhere (FF_BROADCAST_CORE / FF_FEEDS_BROADCAST unset
// in every .env*/docker-compose.yml), unreachable at runtime, untouched since its single creation
// commit ~6 months ago. BLOCKED from deletion: feeds.module.ts/feeds.controller.ts hard-depend on
// this module at compile time (see src/ARCHIVED_LEGACY_BROADCAST.md for the full writeup).
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
