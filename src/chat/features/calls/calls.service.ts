// src/chat/features/calls/calls.service.ts

import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import {
  CallParticipant,
  CallParticipantStatus,
  CallSession,
  CallSessionDocument,
  CallSignalEvent,
} from './schemas/call-session.schema'

type UpsertCallArgs = {
  conversationId: string
  callId: string
  createdBy: string
  media?: string
  inviteeUserIds?: string[]
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name)

  constructor(@InjectModel(CallSession.name) private readonly calls: Model<CallSessionDocument>) {}

  /**
   * ✅ Required by realtime handlers (optional dep):
   * upsertState({ conversationId, state })
   *
   * "state" shape is frontend/gateway-defined; we do best-effort mapping.
   */
  async upsertState(args: { conversationId: string; state: any }): Promise<void> {
    const s = args.state ?? {}

    // Best-effort: if it looks like a call creation payload, ensure it exists.
    // Expected-ish: { callId, createdBy, media, inviteeUserIds }
    if (s.callId && s.createdBy) {
      try {
        await this.createCallOrThrowIfActiveInConversation({
          conversationId: args.conversationId,
          callId: String(s.callId),
          createdBy: String(s.createdBy),
          media: s.media ? String(s.media) : undefined,
          inviteeUserIds: Array.isArray(s.inviteeUserIds) ? s.inviteeUserIds.map(String) : undefined,
        })
        return
      } catch (e: any) {
        // If already active, ignore (unique partial index enforces)
        this.logger.debug(`upsertState ignored: ${e?.message ?? e}`)
        return
      }
    }

    // Otherwise: no-op (state doesn't map cleanly to persistence)
    this.logger.debug('upsertState no-op: state did not include callId+createdBy')
  }

  /**
   * ✅ Required by realtime handlers (optional dep):
   * clearState({ conversationId })
   *
   * End any active call in that conversation.
   */
  async clearState(args: { conversationId: string }): Promise<void> {
    const active = await this.calls
      .findOne({ conversationId: args.conversationId, isActiveInConversation: true })
      .lean()

    if (!active) return

    await this.calls.updateOne(
      { conversationId: args.conversationId, callId: active.callId },
      { $set: { status: 'ended', endedAt: new Date(), isActiveInConversation: false } },
    )
  }

  async listUserCalls(input: {
    userId: string
    limit?: number
    before?: string
  }): Promise<{ calls: any[] }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
    const q: any = {
      $or: [
        { createdBy: input.userId },
        { 'participants.userId': input.userId },
      ],
    }
    if (input.before) {
      const before = new Date(input.before)
      if (!Number.isNaN(before.getTime())) {
        q.startedAt = { $lt: before }
      }
    }

    const rows = await this.calls
      .find(q)
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean()

    return {
      calls: rows.map((r: any) => ({
        id: String(r._id),
        conversationId: r.conversationId,
        callId: r.callId,
        createdBy: r.createdBy,
        status: r.status,
        media: r.media,
        startedAt: r.startedAt?.toISOString?.() ?? String(r.startedAt),
        endedAt: r.endedAt?.toISOString?.() ?? (r.endedAt ? String(r.endedAt) : null),
        participants: Array.isArray(r.participants) ? r.participants : [],
      })),
    }
  }

  async createCallOrThrowIfActiveInConversation(args: UpsertCallArgs): Promise<CallSession> {
    const now = new Date()

    const participants: CallParticipant[] = []

    participants.push({
      userId: args.createdBy,
      status: 'connecting',
      invitedAt: now,
      joinedAt: null,
      leftAt: null,
      reason: null,
    })

    if (args.inviteeUserIds?.length) {
      for (const uid of args.inviteeUserIds) {
        if (uid === args.createdBy) continue
        participants.push({
          userId: uid,
          status: 'invited',
          invitedAt: now,
          joinedAt: null,
          leftAt: null,
          reason: null,
        })
      }
    }

    const doc = await this.calls.create({
      conversationId: args.conversationId,
      callId: args.callId,
      createdBy: args.createdBy,
      status: 'ringing',
      startedAt: now,
      endedAt: null,
      media: args.media ?? 'voice',
      participants,
      signals: [],
      isActiveInConversation: true,
    })

    return doc.toObject()
  }

  async getCall(conversationId: string, callId: string): Promise<CallSession | null> {
    return this.calls.findOne({ conversationId, callId }).lean()
  }

  async markActive(conversationId: string, callId: string): Promise<CallSession | null> {
    return this.calls
      .findOneAndUpdate(
        { conversationId, callId, status: 'ringing' },
        { $set: { status: 'active' } },
        { new: true },
      )
      .lean()
  }

  async setParticipantStatus(
    conversationId: string,
    callId: string,
    userId: string,
    status: CallParticipantStatus,
    reason?: string,
  ): Promise<CallSession | null> {
    const now = new Date()

    const call = await this.calls.findOne({ conversationId, callId }).lean()
    if (!call) return null

    const existing = call.participants.find((p) => p.userId === userId)

    if (!existing) {
      await this.calls.updateOne(
        { conversationId, callId },
        {
          $push: {
            participants: {
              userId,
              status,
              invitedAt: now,
              joinedAt: status === 'joined' ? now : null,
              leftAt: status === 'left' || status === 'rejected' || status === 'busy' ? now : null,
              reason: reason ?? null,
            },
          },
        },
      )
    } else {
      const update: any = { 'participants.$.status': status }
      if (reason !== undefined) update['participants.$.reason'] = reason ?? null

      if (status === 'joined') update['participants.$.joinedAt'] = now
      if (status === 'left' || status === 'rejected' || status === 'busy') update['participants.$.leftAt'] = now

      await this.calls.updateOne(
        { conversationId, callId, 'participants.userId': userId },
        { $set: update },
      )
    }

    return this.calls.findOne({ conversationId, callId }).lean()
  }

  async appendSignal(
    conversationId: string,
    callId: string,
    evt: Omit<CallSignalEvent, 'createdAt'> & { createdAt?: Date },
    maxSignals = 200,
  ): Promise<void> {
    const createdAt = evt.createdAt ?? new Date()

    await this.calls.updateOne(
      { conversationId, callId },
      {
        $push: {
          signals: {
            $each: [{ ...evt, createdAt }],
            $slice: -maxSignals,
          },
        },
      },
    )
  }

  async endCall(
    conversationId: string,
    callId: string,
    endedByUserId: string,
    reason?: string,
  ): Promise<CallSession | null> {
    const now = new Date()

    await this.calls.updateOne(
      { conversationId, callId, status: { $ne: 'ended' } },
      {
        $set: {
          status: 'ended',
          endedAt: now,
          isActiveInConversation: false,
        },
      },
    )

    await this.setParticipantStatus(conversationId, callId, endedByUserId, 'left', reason)

    return this.calls.findOne({ conversationId, callId }).lean()
  }

  async ensureCallExistsOrThrow(conversationId: string, callId: string): Promise<CallSession> {
    const call = await this.getCall(conversationId, callId)
    if (!call) throw new Error('CALL_NOT_FOUND')
    return call
  }

  async assertNotEnded(call: CallSession): Promise<void> {
    if (call.status === 'ended') throw new Error('CALL_ALREADY_ENDED')
  }

  async endIfNoActiveParticipants(conversationId: string, callId: string): Promise<void> {
    const call = await this.getCall(conversationId, callId)
    if (!call || call.status === 'ended') return

    const anyStillIn =
      call.participants.some((p) => p.status === 'joined' || p.status === 'connecting' || p.status === 'invited')

    if (!anyStillIn) {
      await this.calls.updateOne(
        { conversationId, callId },
        { $set: { status: 'ended', endedAt: new Date(), isActiveInConversation: false } },
      )
    }
  }
}
