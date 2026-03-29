// src/chat/features/reactions/reactions.service.ts
import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'

// ✅ Use relative import (avoid 'src/...')
import { Message, MessageDocument } from '../messages/schemas/message.schema'

export type ReactionInput = {
  conversationId: string
  messageId: string
  userId: string
  emoji: string
  mode: 'add' | 'remove'
  nowMs?: number
}

@Injectable()
export class ReactionsService {
  constructor(@InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>) {}

  /**
   * ✅ Required by realtime handlers:
   * toggleReaction({ userId, conversationId, messageId, emoji })
   *
   * WhatsApp-like behavior: toggles on/off.
   */
  async toggleReaction(args: {
    userId: string
    conversationId: string
    messageId: string
    emoji: string
  }): Promise<any> {
    // Determine current state (if same emoji exists for user => remove, else add)
    const msg = await this.messageModel.findOne({
      _id: new Types.ObjectId(args.messageId),
      conversationId: args.conversationId,
    })

    if (!msg) throw new NotFoundException('Message not found')

    const existing = (msg.reactions ?? []).find((r: any) => r.userId === args.userId)

    const mode: ReactionInput['mode'] =
      existing?.emoji === args.emoji ? 'remove' : 'add'

    return this.react({
      conversationId: args.conversationId,
      messageId: args.messageId,
      userId: args.userId,
      emoji: args.emoji,
      mode,
    })
  }

  async react(input: ReactionInput) {
    const now = input.nowMs ?? Date.now()

    const msg = await this.messageModel.findOne({
      _id: new Types.ObjectId(input.messageId),
      conversationId: input.conversationId,
    })
    if (!msg) throw new NotFoundException('Message not found')

    // WhatsApp-like: one reaction per user (enforced by removing previous)
    msg.reactions = (msg.reactions ?? []).filter((r: any) => r.userId !== input.userId)

    if (input.mode === 'add') {
      msg.reactions.push({ userId: input.userId, emoji: input.emoji, at: now } as any)
    }

    await msg.save()
    return msg
  }
}
