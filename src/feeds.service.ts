import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'

import { FeedPost, FeedComment, FeedPostDocument } from './feed-post.schema'

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

  async findAll(tenantId: string, opts: { limit?: number; cursor?: string } = {}): Promise<FeedPostDocument[]> {
    const limit = Math.min(opts.limit ?? 20, 100)
    const query: Record<string, any> = { tenantId }
    if (opts.cursor && Types.ObjectId.isValid(opts.cursor)) {
      query._id = { $lt: new Types.ObjectId(opts.cursor) }
    }
    return this.feedModel
      .find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .exec()
  }

  async delete(tenantId: string, id: string, authorId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false
    const result = await this.feedModel
      .deleteOne({ _id: new Types.ObjectId(id), tenantId, authorId })
      .exec()
    return result.deletedCount > 0
  }

  async getPost(tenantId: string, id: string): Promise<FeedPostDocument | null> {
    return this.findById(tenantId, id)
  }

  async toggleReaction(tenantId: string, postId: string, userId: string): Promise<FeedPostDocument | null> {
    if (!Types.ObjectId.isValid(postId)) return null
    const post = await this.feedModel.findOne({ _id: new Types.ObjectId(postId), tenantId }).exec()
    if (!post) return null
    const already = post.reactions.includes(userId)
    if (already) {
      post.reactions = post.reactions.filter((id) => id !== userId)
    } else {
      post.reactions.push(userId)
    }
    return post.save()
  }

  async addComment(tenantId: string, postId: string, userId: string, content: string): Promise<FeedPostDocument | null> {
    if (!Types.ObjectId.isValid(postId)) return null
    const comment: FeedComment = { userId, content, createdAt: new Date() }
    const post = await this.feedModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(postId), tenantId },
        { $push: { comments: comment } },
        { new: true },
      )
      .exec()
    return post
  }
}
