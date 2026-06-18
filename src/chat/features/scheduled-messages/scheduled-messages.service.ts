// src/chat/features/scheduled-messages/scheduled-messages.service.ts

import { Injectable, ForbiddenException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { Message, MessageDocument } from '../messages/schemas/message.schema'

@Injectable()
export class ScheduledMessagesService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
  ) {}

  /**
   * Returns all messages whose scheduledAt <= now and have not yet been delivered.
   * Marks them as delivered atomically before returning.
   */
  async pollDue(): Promise<MessageDocument[]> {
    const now = new Date()
    const due = await this.messageModel
      .find({
        scheduledAt: { $lte: now },
        scheduledDelivered: false,
        isDeleted: { $ne: true },
      })
      .exec()

    if (!due.length) return []

    const ids = due.map((d) => (d as any)._id)
    await this.messageModel.updateMany(
      { _id: { $in: ids } },
      { $set: { scheduledDelivered: true } },
    )

    return due
  }

  async cancelScheduled(args: { messageId: string; userId: string }): Promise<MessageDocument | null> {
    const msg = await this.messageModel.findOne({ _id: args.messageId })
    if (!msg) return null
    if (String((msg as any).senderId) !== String(args.userId)) {
      throw new ForbiddenException('Only the sender can cancel a scheduled message')
    }
    ;(msg as any).isDeleted = true
    ;(msg as any).scheduledDelivered = true
    ;(msg as any).deleteState = 'deleted_for_everyone'
    await (msg as any).save()
    return msg
  }
}
