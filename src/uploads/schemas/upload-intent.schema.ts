// src/uploads/schemas/upload-intent.schema.ts
//
// Mirrors Django's MediaUploadIntent (apps/media/models.py +
// apps/media/upload_intent.py): a short-lived record created at `initiate`
// time that pins the object key to its owner, so `confirm` never has to
// trust a client-supplied key — only a client-supplied upload_id it already
// owns.

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UploadIntentDocument = HydratedDocument<UploadIntent>;

export type UploadIntentStatus =
  | 'pending'
  | 'uploaded'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'aborted';

@Schema({ timestamps: true })
export class UploadIntent {
  @Prop({ required: true, index: true })
  ownerId!: string;

  @Prop({ required: true })
  context!: string;

  @Prop({ required: true, unique: true })
  objectKey!: string;

  @Prop({ required: true })
  contentType!: string;

  @Prop({ required: true })
  originalFilename!: string;

  @Prop({ required: true, min: 0 })
  sizeBytes!: number;

  @Prop({
    required: true,
    enum: ['pending', 'uploaded', 'confirmed', 'failed', 'expired', 'aborted'],
    default: 'pending',
  })
  status!: UploadIntentStatus;

  @Prop({ type: Date, required: true, index: true })
  expiresAt!: Date;

  @Prop()
  conversationId?: string;

  @Prop()
  clientId?: string;

  /** Finalized attachment JSON, cached on first confirm so repeat confirm
   * calls (client retry after a dropped response) are idempotent. */
  @Prop({ type: Object })
  confirmedAttachment?: Record<string, unknown>;

  @Prop()
  failureReason?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const UploadIntentSchema = SchemaFactory.createForClass(UploadIntent);

UploadIntentSchema.index({ status: 1, expiresAt: 1 });
