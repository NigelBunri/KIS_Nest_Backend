// src/chat/features/scheduled-messages/scheduled-messages.service.ts

import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import {
  ScheduledMessage,
  ScheduledMessageDocument,
  ScheduledMessageStatus,
} from './schemas/scheduled-message.schema'

// How much "in the future" the schedule time must be, so a near-instant
// schedule request doesn't race the cron (which polls every 15s) into
// skipping an attempt only to pick it up seconds later anyway.
const MIN_LEAD_MS = 10_000

// How long a worker gets to finish one delivery attempt before a later
// poll (this instance restarting, or another instance) treats it as
// abandoned and requeues it — the overdue-recovery policy for crashes.
const STALE_PROCESSING_MS = 2 * 60_000

function backoffMs(attempts: number): number {
  // 30s, 1m, 2m, 4m, capped at 30m.
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000)
}

export type SchedulePendingPage = {
  items: ScheduledMessageDocument[]
  nextCursor: string | null
}

@Injectable()
export class ScheduledMessagesService {
  constructor(
    @InjectModel(ScheduledMessage.name)
    private readonly model: Model<ScheduledMessageDocument>,
  ) {}

  async schedule(args: {
    conversationId: string
    senderId: string
    senderDeviceId?: string
    senderName?: string
    clientId: string
    payload: Record<string, any>
    scheduledAt: Date
  }): Promise<ScheduledMessageDocument> {
    if (!(args.scheduledAt instanceof Date) || Number.isNaN(args.scheduledAt.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid date')
    }
    if (args.scheduledAt.getTime() < Date.now() + MIN_LEAD_MS) {
      throw new BadRequestException('scheduledAt must be at least 10 seconds in the future')
    }

    const existing = await this.model.findOne({
      conversationId: args.conversationId,
      clientId: args.clientId,
    })
    if (existing) return existing

    try {
      return await new this.model({
        conversationId: args.conversationId,
        senderId: args.senderId,
        senderDeviceId: args.senderDeviceId,
        senderName: args.senderName,
        clientId: args.clientId,
        payload: args.payload,
        scheduledAt: args.scheduledAt,
        nextAttemptAt: args.scheduledAt,
        status: 'scheduled',
      }).save()
    } catch (e: any) {
      if (e?.code === 11000) {
        const again = await this.model.findOne({
          conversationId: args.conversationId,
          clientId: args.clientId,
        })
        if (again) return again
      }
      throw e
    }
  }

  async listPending(args: {
    senderId: string
    limit?: number
    cursor?: string | null
  }): Promise<SchedulePendingPage> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
    const filter: any = {
      senderId: args.senderId,
      status: { $in: ['scheduled', 'processing', 'failed'] },
    }

    const cursor = decodeCursor(args.cursor)
    if (cursor) {
      filter.$or = [
        { scheduledAt: { $gt: cursor.scheduledAt } },
        { scheduledAt: cursor.scheduledAt, _id: { $gt: cursor.id } },
      ]
    }

    const items = await this.model
      .find(filter)
      .sort({ scheduledAt: 1, _id: 1 })
      .limit(limit + 1)
      .exec()

    const hasMore = items.length > limit
    const page = hasMore ? items.slice(0, limit) : items
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? encodeCursor((last as any).scheduledAt, String((last as any)._id)) : null

    return { items: page, nextCursor }
  }

  async getOwned(id: string, senderId: string): Promise<ScheduledMessageDocument> {
    const doc = await this.model.findOne({ _id: id, senderId })
    if (!doc) throw new NotFoundException('Scheduled message not found')
    return doc
  }

  /**
   * Cancels a scheduled message — but only while it's still safely
   * cancellable. If a worker has already claimed it ('processing') or it
   * already went out ('sent'), the conditional filter below simply won't
   * match, so this never pretends to cancel something delivery has already
   * made irreversible; the caller gets back the message's ACTUAL current
   * status to report honestly instead.
   */
  async cancel(args: { id: string; senderId: string }): Promise<{ ok: boolean; status: ScheduledMessageStatus }> {
    const updated = await this.model.findOneAndUpdate(
      { _id: args.id, senderId: args.senderId, status: 'scheduled' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
      { new: true },
    )
    if (updated) return { ok: true, status: 'cancelled' }

    const current = await this.getOwned(args.id, args.senderId)
    return { ok: false, status: current.status }
  }

  /**
   * Edits content and/or reschedules — same "only while still 'scheduled'"
   * guard as cancel, for the same reason (section 4's "concurrent editing
   * and sending" requirement): once a worker has claimed the item there is
   * no safe window left to mutate it out from under an in-flight send.
   */
  async reschedule(args: {
    id: string
    senderId: string
    payload?: Record<string, any>
    scheduledAt?: Date
  }): Promise<{ ok: boolean; status: ScheduledMessageStatus; doc?: ScheduledMessageDocument }> {
    if (args.scheduledAt) {
      if (Number.isNaN(args.scheduledAt.getTime())) {
        throw new BadRequestException('scheduledAt must be a valid date')
      }
      if (args.scheduledAt.getTime() < Date.now() + MIN_LEAD_MS) {
        throw new BadRequestException('scheduledAt must be at least 10 seconds in the future')
      }
    }

    const set: Record<string, any> = {}
    if (args.payload) set.payload = args.payload
    if (args.scheduledAt) {
      set.scheduledAt = args.scheduledAt
      set.nextAttemptAt = args.scheduledAt
    }
    if (!Object.keys(set).length) {
      const current = await this.getOwned(args.id, args.senderId)
      return { ok: true, status: current.status, doc: current }
    }

    const updated = await this.model.findOneAndUpdate(
      { _id: args.id, senderId: args.senderId, status: 'scheduled' },
      { $set: set },
      { new: true },
    )
    if (updated) return { ok: true, status: 'scheduled', doc: updated }

    const current = await this.getOwned(args.id, args.senderId)
    return { ok: false, status: current.status }
  }

  /**
   * Atomically claims up to `limit` due items for THIS call. Each claim is
   * its own single-document findOneAndUpdate — Mongo guarantees exactly one
   * caller can win each document's update even with multiple cron instances
   * (or multiple app replicas) polling concurrently, so no extra
   * distributed lock is needed for exactly-once delivery.
   */
  async claimNextDue(limit: number): Promise<ScheduledMessageDocument[]> {
    const now = new Date()
    const claimed: ScheduledMessageDocument[] = []
    for (let i = 0; i < limit; i++) {
      const next = await this.model.findOneAndUpdate(
        { status: { $in: ['scheduled', 'failed'] }, nextAttemptAt: { $lte: now } },
        { $set: { status: 'processing', processingStartedAt: now }, $inc: { attempts: 1 } },
        { sort: { nextAttemptAt: 1 }, new: true },
      )
      if (!next) break
      claimed.push(next)
    }
    return claimed
  }

  async markSent(id: string, args: { sentMessageId: string; sentSeq: number }): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      { $set: { status: 'sent', sentMessageId: args.sentMessageId, sentSeq: args.sentSeq } },
    )
  }

  /**
   * Records a failed delivery attempt. Below maxAttempts, reverts to
   * 'scheduled' with an exponential backoff so the cron retries it later —
   * above maxAttempts (or when the caller flags the error as permanent,
   * e.g. the sender lost membership), it's marked 'failed' for good and
   * left visible to the user rather than silently vanishing or retrying
   * forever.
   */
  async markFailed(id: string, args: { error: string; permanent?: boolean }): Promise<void> {
    const doc = await this.model.findById(id)
    if (!doc) return
    const permanent = args.permanent || doc.attempts >= doc.maxAttempts
    if (permanent) {
      await this.model.updateOne(
        { _id: id },
        { $set: { status: 'failed', lastError: args.error.slice(0, 500) } },
      )
    } else {
      await this.model.updateOne(
        { _id: id },
        {
          $set: {
            status: 'scheduled',
            lastError: args.error.slice(0, 500),
            nextAttemptAt: new Date(Date.now() + backoffMs(doc.attempts)),
          },
        },
      )
    }
  }

  /**
   * Requeues items stuck in 'processing' long enough that their worker must
   * have died (crash, deploy restart) before marking sent/failed — the
   * documented overdue-recovery policy for downtime. Run on boot and on
   * every poll tick so it also catches a crash mid-session, not just one
   * that happened while this instance was down.
   */
  async recoverStaleProcessing(): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS)
    const res = await this.model.updateMany(
      { status: 'processing', processingStartedAt: { $lt: staleBefore } },
      { $set: { status: 'scheduled', nextAttemptAt: new Date() } },
    )
    return res.modifiedCount ?? 0
  }

  async assertSender(doc: ScheduledMessageDocument, userId: string): Promise<void> {
    if (String(doc.senderId) !== String(userId)) {
      throw new ForbiddenException('Only the sender can manage this scheduled message')
    }
  }
}

function encodeCursor(scheduledAt: Date, id: string): string {
  return Buffer.from(`${scheduledAt.toISOString()}|${id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor?: string | null): { scheduledAt: Date; id: string } | null {
  if (!cursor) return null
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const [iso, id] = raw.split('|')
    const scheduledAt = new Date(iso)
    if (!id || Number.isNaN(scheduledAt.getTime())) return null
    return { scheduledAt, id }
  } catch {
    return null
  }
}
