import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type DeviceTokenDocument = HydratedDocument<DeviceToken>

@Schema({ timestamps: true })
export class DeviceToken {
  @Prop({ type: String, required: true, index: true })
  userId!: string

  @Prop({ type: String, required: true, enum: ['android', 'ios', 'web'], index: true })
  platform!: 'android' | 'ios' | 'web'

  @Prop({ type: String, required: true })
  token!: string

  // ✅ Fix: avoid union type (string | null) and explicitly declare Mongoose type
  @Prop({ type: String, default: null })
  deviceId?: string

  @Prop({ type: Boolean, default: true })
  active!: boolean

  // Distinguishes a regular FCM token from an iOS PushKit VoIP token (which
  // must be delivered via direct APNs, never through FCM). Missing on
  // documents written before this field existed — treat as 'fcm'.
  @Prop({ type: String, enum: ['fcm', 'voip'], default: 'fcm' })
  tokenType!: 'fcm' | 'voip'
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken)

DeviceTokenSchema.index({ userId: 1, token: 1 }, { unique: true })
DeviceTokenSchema.index({ token: 1 }, { unique: true })
DeviceTokenSchema.index({ userId: 1, createdAt: -1 })
