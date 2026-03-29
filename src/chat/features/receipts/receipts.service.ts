// src/chat/features/receipts/receipts.service.ts

import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

// ✅ Use relative import (avoid 'src/...')
import { Message, MessageDocument, ReceiptEntry } from '../messages/schemas/message.schema'

export type ReceiptInput = {
  conversationId: string
  messageId: string
  userId: string
  deviceId: string
  type: 'delivered' | 'read' | 'played'
  atMs?: number
}

@Injectable()
export class ReceiptsService {
  constructor(@InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>) {}

  /**
   * ✅ Required by realtime handlers:
   * applyReceipt({ userId, conversationId, messageId, type })
   *
   * Handler doesn't currently provide deviceId, so we allow fallback.
   */
  async applyReceipt(args: {
    userId: string
    conversationId: string
    messageId: string
    type: 'delivered' | 'read' | 'played'
    deviceId?: string
    atMs?: number
  }): Promise<any> {
    return this.addReceipt({
      conversationId: args.conversationId,
      messageId: args.messageId,
      userId: args.userId,
      deviceId: args.deviceId ?? 'unknown',
      type: args.type,
      atMs: args.atMs,
    })
  }

  async addReceipt(input: ReceiptInput) {
    const msg = await this.messageModel.findOne({
      _id: input.messageId,
      conversationId: input.conversationId,
    })

    if (!msg) throw new NotFoundException('message not found')

    const atMs = input.atMs ?? Date.now()

    const entry: ReceiptEntry = {
      userId: input.userId,
      deviceId: input.deviceId,
      atMs,
    }

    if (input.type === 'delivered') (msg as any).deliveredTo = this.upsert((msg as any).deliveredTo ?? [], entry)
    if (input.type === 'read') {
      ;(msg as any).readBy = this.upsert((msg as any).readBy ?? [], entry)

      if ((msg as any).ephemeral?.enabled && (msg as any).ephemeral?.startAfterRead) {
        if (!(msg as any).ephemeral.expireAt && (msg as any).ephemeral.ttlSeconds) {
          ;(msg as any).ephemeral.expireAt = atMs + (msg as any).ephemeral.ttlSeconds * 1000
        }
      }
    }
    if (input.type === 'played') (msg as any).playedBy = this.upsert((msg as any).playedBy ?? [], entry)

    await msg.save()
    return msg
  }

  private upsert(list: ReceiptEntry[], entry: ReceiptEntry): ReceiptEntry[] {
    const filtered = (list ?? []).filter((x) => x.userId !== entry.userId)
    filtered.push(entry)
    return filtered
  }
}
