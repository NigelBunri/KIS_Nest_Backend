import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'

import { FeedPost, FeedPostDocument } from './feed-post.schema'

type CreateFeedParams = {
  tenantId: string
  authorId: string
  text?: string
  attachments?: any[]
  communityId?: string
  partnerProfileId?: string
  channelMessageId?: string
  sourceConversationId?: string
}

@Injectable()
export class FeedsService {
  constructor(@InjectModel(FeedPost.name) private readonly feedModel: Model<FeedPostDocument>) {}

  async create(params: CreateFeedParams): Promise<FeedPostDocument> {
    const created = new this.feedModel({
      tenantId: params.tenantId,
      authorId: params.authorId,
      text: params.text ?? '',
      attachments: params.attachments ?? [],
      communityId: params.communityId,
      partnerProfileId: params.partnerProfileId,
      channelMessageId: params.channelMessageId,
      sourceConversationId: params.sourceConversationId,
    })
    return created.save()
  }

  async findById(tenantId: string, id: string): Promise<FeedPostDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null
    return this.feedModel.findOne({ _id: new Types.ObjectId(id), tenantId }).exec()
  }
}
