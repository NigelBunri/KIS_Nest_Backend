import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'

import { BroadcastItem, BroadcastItemDocument } from './broadcast-item.schema'
import {
  BroadcastEngagement,
  BroadcastSourceType,
  BroadcastVisibility,
  BroadcastVertical,
  CreateBroadcastItemParams,
} from './broadcast.types'
import { ChatGateway } from './realtime/chat.gateway'

type CursorPayload = {
  createdAt: Date
  id: string
}

type BroadcastListItem = BroadcastItem & { _id: Types.ObjectId }

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name)

  constructor(
    @InjectModel(BroadcastItem.name) private readonly broadcastModel: Model<BroadcastItemDocument>,
    private readonly chatGateway: ChatGateway,
  ) {}

  async createItem(params: CreateBroadcastItemParams): Promise<BroadcastItemDocument> {
    const idempotency = params.idempotencyKey?.trim()
    if (idempotency) {
      const existing = await this.broadcastModel.findOne({
        tenantId: params.tenantId,
        idempotencyKey: idempotency,
      })
      if (existing) return existing
    }

    const doc = new this.broadcastModel({
      tenantId: params.tenantId,
      creatorId: params.creatorId,
      vertical: params.vertical,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      title: params.title,
      body: params.body,
      attachments: params.attachments ?? [],
      metadata: params.metadata ?? {},
      visibility: params.visibility ?? BroadcastVisibility.PUBLIC,
      idempotencyKey: idempotency ?? null,
      broadcastedAt: new Date(),
    })

    try {
      const created = await doc.save()
      this.emitCreated(created)
      return created
    } catch (error: any) {
      if (error?.code === 11000 && idempotency) {
        const again = await this.broadcastModel.findOne({
          tenantId: params.tenantId,
          idempotencyKey: idempotency,
        })
        if (again) {
          return again
        }
      }
      throw error
    }
  }

  async listForVertical(options: {
    tenantId: string
    vertical?: BroadcastVertical
    cursor?: string
    limit?: number
  }): Promise<{ items: BroadcastListItem[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50)
    const query: Record<string, any> = { tenantId: options.tenantId }
    if (options.vertical) {
      query.vertical = options.vertical
    }
    if (options.cursor) {
      const parsed = this.decodeCursor(options.cursor)
      if (parsed) {
        query.$or = [
          { broadcastedAt: { $lt: parsed.createdAt } },
          { broadcastedAt: parsed.createdAt, _id: { $lt: new Types.ObjectId(parsed.id) } },
        ]
      }
    }

    const docs = (await this.broadcastModel
      .find(query)
      .sort({ broadcastedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean()) as BroadcastListItem[]

    const hasMore = docs.length > limit
    const items = docs.slice(0, limit)
    const nextCursor = hasMore && items.length ? this.encodeCursor(items[items.length - 1]) : undefined
    return { items, nextCursor }
  }

  async findById(id: string, tenantId: string): Promise<BroadcastItemDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null
    return this.broadcastModel.findOne({ _id: new Types.ObjectId(id), tenantId }).exec()
  }

  async adjustEngagement(id: string, delta: Partial<Record<keyof BroadcastEngagement, number>>) {
    const inc: Record<string, number> = {}
    for (const [key, val] of Object.entries(delta)) {
      if (!val) continue
      inc[`engagement.${key}`] = val
    }
    if (!Object.keys(inc).length) return
    await this.broadcastModel.findOneAndUpdate({ _id: id }, { $inc: inc }).exec()
  }

  private encodeCursor(doc: Pick<BroadcastListItem, '_id' | 'broadcastedAt'>) {
    const created = doc.broadcastedAt?.toISOString() ?? new Date().toISOString()
    return Buffer.from(`${created}::${doc._id.toString()}`).toString('base64')
  }

  private decodeCursor(cursor: string): CursorPayload | null {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8')
      const [createdAtStr, id] = decoded.split('::')
      if (!createdAtStr || !id) return null
      const createdAt = new Date(createdAtStr)
      if (Number.isNaN(createdAt.getTime())) return null
      if (!Types.ObjectId.isValid(id)) return null
      return { createdAt, id }
    } catch {
      return null
    }
  }

  private emitCreated(doc: BroadcastItemDocument) {
    const server = this.chatGateway.server
    if (!server) {
      this.logger.debug('Socket server not ready, skipping broadcast.created emit')
      return
    }
    const payload = {
      id: doc._id.toString(),
      tenantId: doc.tenantId,
      creatorId: doc.creatorId,
      vertical: doc.vertical,
      sourceId: doc.sourceId,
      sourceType: doc.sourceType,
      title: doc.title,
      body: doc.body,
      attachments: doc.attachments,
      metadata: doc.metadata,
      visibility: doc.visibility,
      broadcastedAt: doc.broadcastedAt,
      engagement: doc.engagement,
    }
    server.to(`broadcast:tenant:${doc.tenantId}`).emit('broadcast.created', payload)
  }
}
