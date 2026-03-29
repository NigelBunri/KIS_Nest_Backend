import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { randomUUID } from 'node:crypto'

import {
  BROADCAST_CONVERSATION_PREFIX,
} from '../../chat.types'
import {
  BroadcastConversation,
  BroadcastConversationDocument,
} from './broadcast-conversation.schema'

@Injectable()
export class BroadcastConversationsService {
  constructor(
    @InjectModel(BroadcastConversation.name)
    private readonly model: Model<BroadcastConversationDocument>,
  ) {}

  async ensureConversation(broadcastId: string): Promise<BroadcastConversation> {
    const normalized = String(broadcastId).trim()
    if (!normalized) {
      throw new Error('broadcastId is required')
    }

    const existing = await this.model.findOne({ broadcastId: normalized }).exec()
    if (existing) return existing

    const conversationId = `${BROADCAST_CONVERSATION_PREFIX}${randomUUID()}`
    const created = new this.model({
      broadcastId: normalized,
      conversationId,
      title: 'Broadcast comments',
    })

    return created.save()
  }
}
