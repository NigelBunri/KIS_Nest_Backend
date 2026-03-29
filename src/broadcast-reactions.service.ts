import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import { BroadcastReaction, BroadcastReactionDocument } from './broadcast-reaction.schema'
import { BroadcastService } from './broadcast.service'

@Injectable()
export class BroadcastReactionsService {
  constructor(
    @InjectModel(BroadcastReaction.name)
    private readonly reactionModel: Model<BroadcastReactionDocument>,
    private readonly broadcastService: BroadcastService,
  ) {}

  async addReaction(params: { userId: string; broadcastItemId: string; type: string }) {
    const existing = await this.reactionModel.findOne({
      broadcastItemId: params.broadcastItemId,
      userId: params.userId,
      type: params.type,
    })
    if (existing) return existing

    const created = await this.reactionModel.create({
      broadcastItemId: params.broadcastItemId,
      userId: params.userId,
      type: params.type,
    })
    await this.broadcastService.adjustEngagement(params.broadcastItemId, { reactions: 1 })
    return created
  }
}
