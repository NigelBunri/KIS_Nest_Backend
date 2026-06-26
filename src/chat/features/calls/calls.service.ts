// src/chat/features/calls/calls.service.ts

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import * as crypto from 'crypto'
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
  callType?: string
  media?: string
  inviteeUserIds?: string[]
}

type StandaloneCallArgs = {
  callId: string
  createdBy: string
  callType: string
  title: string
  scheduledFor?: Date | null
  inviteeUserIds?: string[]
}

type NotificationsServiceRef = {
  notifyMissedCall(input: {
    toUserId: string
    fromUserId: string
    fromDisplayName?: string
    conversationId: string
    callId: string
    callType?: string
  }): Promise<any>
}

@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name)
  private cleanupTimer?: NodeJS.Timeout
  private _notificationsService?: NotificationsServiceRef

  constructor(@InjectModel(CallSession.name) private readonly calls: Model<CallSessionDocument>) {}

  /** Injected lazily to avoid circular dependency. */
  setNotificationsService(svc: NotificationsServiceRef) {
    this._notificationsService = svc
  }

  onModuleInit() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleCalls().catch((e: any) =>
        this.logger.warn('[calls] cleanupStaleCalls failed', e?.message),
      )
    }, 30_000)
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
  }

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
          callType: s.callType ? String(s.callType) : undefined,
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

  getUserFacingStatus(call: any, userId: string): string {
    if (call.status === 'active') return 'ongoing'
    if (call.status === 'ringing') return 'ringing'
    if (call.status === 'pending') return 'pending'

    const participants = Array.isArray(call.participants) ? call.participants : []
    const participant = participants.find((row: any) => String(row.userId) === String(userId))
    const joined = Boolean(participant?.joinedAt)
    if (participant?.status === 'busy') return 'busy'
    if (participant?.status === 'rejected') return 'declined'
    if (joined) return 'completed'

    if (String(call.createdBy) === String(userId)) {
      const anotherJoined = participants.some(
        (row: any) => String(row.userId) !== String(userId) && Boolean(row.joinedAt),
      )
      return anotherJoined ? 'completed' : 'cancelled'
    }
    return 'missed'
  }

  async listUserCalls(input: {
    userId: string
    limit?: number
    before?: string
  }): Promise<{ calls: any[] }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
    // Coerce to string so the query matches regardless of whether the ID was
    // stored as a number or string (socket vs REST auth may differ in type).
    const uid = String(input.userId)
    const q: any = {
      $or: [
        { createdBy: uid },
        { 'participants.userId': uid },
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
      calls: rows.map((r: any) => {
        const startMs = r.startedAt instanceof Date ? r.startedAt.getTime() : new Date(r.startedAt).getTime()
        const endMs = r.endedAt instanceof Date ? r.endedAt.getTime() : (r.endedAt ? new Date(r.endedAt).getTime() : null)
        const durationSeconds = endMs != null && !Number.isNaN(startMs) && !Number.isNaN(endMs)
          ? Math.max(0, Math.round((endMs - startMs) / 1000))
          : null
        const participants = Array.isArray(r.participants) ? r.participants : []
        return {
          id: String(r._id),
          conversationId: r.conversationId,
          callId: r.callId,
          createdBy: r.createdBy,
          status: this.getUserFacingStatus(r, input.userId),
          rawStatus: r.status,
          userStatus: this.getUserFacingStatus(r, input.userId),
          callType: r.callType ?? r.media ?? 'voice',
          media: r.media,
          startedAt: r.startedAt?.toISOString?.() ?? String(r.startedAt),
          endedAt: r.endedAt?.toISOString?.() ?? (r.endedAt ? String(r.endedAt) : null),
          duration: durationSeconds,
          participantCount: participants.length,
          participants,
          title: r.title ?? null,
          isStandalone: Boolean(r.isStandalone),
        }
      }),
    }
  }

  async createCallOrThrowIfActiveInConversation(args: UpsertCallArgs): Promise<CallSession> {
    // Idempotent: same callId was already created (reconnect / duplicate emit) — return it.
    const existingById = await this.calls
      .findOne({ conversationId: args.conversationId, callId: args.callId })
      .lean()
    if (existingById) {
      this.logger.debug(`[calls] createCall idempotent return callId=${args.callId}`)
      return existingById as CallSession
    }

    // If another call is active for this conversation, auto-end it when it is
    // stale (> 5 min old) — handles the case where call.end was never received
    // by the server due to a network drop.
    const staleThresholdMs = 5 * 60 * 1000
    const existingActive = await this.calls
      .findOne({ conversationId: args.conversationId, isActiveInConversation: true })
      .lean()
    if (existingActive) {
      const ageMs = Date.now() - new Date(existingActive.startedAt).getTime()
      if (ageMs > staleThresholdMs) {
        this.logger.warn(
          `[calls] auto-ending stale active call callId=${existingActive.callId} ageMs=${ageMs}`,
        )
        await this.calls.updateOne(
          { conversationId: args.conversationId, callId: existingActive.callId },
          { $set: { status: 'ended', endedAt: new Date(), isActiveInConversation: false } },
        )
      } else {
        throw new Error('CALL_ALREADY_ACTIVE')
      }
    }

    const now = new Date()

    const participants: CallParticipant[] = []

    participants.push({
      userId: String(args.createdBy),
      status: 'connecting',
      role: 'host',
      invitedAt: now,
      joinedAt: null,
      leftAt: null,
      reason: null,
    })

    if (args.inviteeUserIds?.length) {
      for (const uid of args.inviteeUserIds) {
        if (String(uid) === String(args.createdBy)) continue
        participants.push({
          userId: String(uid),
          status: 'invited',
          role: null,
          invitedAt: now,
          joinedAt: null,
          leftAt: null,
          reason: null,
        })
      }
    }

    const callType = args.callType ?? args.media ?? 'voice'
    const legacyMedia = callType.startsWith('video') ? 'video' : 'voice'

    try {
      const doc = await this.calls.create({
        conversationId: args.conversationId,
        callId: args.callId,
        createdBy: String(args.createdBy),
        status: 'ringing',
        startedAt: now,
        endedAt: null,
        callType,
        media: args.media ?? legacyMedia,
        viewerCount: 0,
        participants,
        signals: [],
        isActiveInConversation: true,
      })

      return doc.toObject()
    } catch (e: any) {
      // MongoDB duplicate key — another concurrent call.offer for same conversation
      // slipped through the race window between our check and insert.
      if (e?.code === 11000) throw new Error('CALL_ALREADY_ACTIVE')
      throw e
    }
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
              role: null,
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
    const call = await this.calls.findOne({ conversationId, callId }).lean()
    if (!call) return null

    const anyJoined = call.participants.some((p) => p.status === 'joined')
    const normalizedReason = String(reason ?? '').trim().toLowerCase()
    const terminalStatus =
      !anyJoined &&
      call.status === 'ringing' &&
      ['cancelled', 'canceled', 'missed', 'rejected', 'busy', 'no_answer'].includes(normalizedReason)
        ? 'missed'
        : 'ended'

    await this.calls.updateOne(
      { conversationId, callId, status: { $ne: 'ended' } },
      {
        $set: {
          status: terminalStatus,
          endedAt: now,
          isActiveInConversation: false,
        },
      },
    )

    await this.setParticipantStatus(conversationId, callId, endedByUserId, 'left', reason)

    return this.calls.findOne({ conversationId, callId }).lean()
  }

  async getCallCreator(conversationId: string, callId: string): Promise<string | null> {
    const call = await this.calls.findOne({ conversationId, callId }, { createdBy: 1 }).lean()
    return call?.createdBy ?? null
  }

  async setParticipantRole(
    conversationId: string,
    callId: string,
    userId: string,
    role: 'host' | 'co-host' | 'speaker' | 'audience',
  ): Promise<void> {
    await this.calls.updateOne(
      { conversationId, callId, 'participants.userId': userId },
      { $set: { 'participants.$.role': role } },
    )
  }

  async bumpViewerCount(conversationId: string, callId: string, delta: 1 | -1): Promise<number> {
    const result = await this.calls.findOneAndUpdate(
      { conversationId, callId, isActiveInConversation: true },
      { $inc: { viewerCount: delta } },
      { new: true, projection: { viewerCount: 1 } },
    ).lean()
    return Math.max(0, result?.viewerCount ?? 0)
  }

  async ensureCallExistsOrThrow(conversationId: string, callId: string): Promise<CallSession> {
    const call = await this.getCall(conversationId, callId)
    if (!call) throw new Error('CALL_NOT_FOUND')
    return call
  }

  async assertNotEnded(call: CallSession): Promise<void> {
    if (call.status === 'ended' || call.status === 'missed') throw new Error('CALL_ALREADY_ENDED')
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

  /** Return the active call (if any) for a specific conversation. */
  async getActiveCall(conversationId: string): Promise<CallSession | null> {
    return this.calls.findOne({ conversationId, isActiveInConversation: true }).lean()
  }

  /**
   * Return recent calls for a specific conversation (for chat history display).
   * Ordered newest-first, capped at limit.
   */
  async getCallsForConversation(conversationId: string, limit = 30): Promise<CallSession[]> {
    return this.calls
      .find({ conversationId })
      .sort({ startedAt: -1 })
      .limit(Math.min(limit, 100))
      .lean()
  }

  async getActiveCallsForUser(userId: string): Promise<CallSession[]> {
    return this.calls
      .find({
        isActiveInConversation: true,
        participants: { $elemMatch: { userId, status: 'joined' } },
      })
      .lean()
  }

  async getParticipantsSnapshot(conversationId: string, callId: string): Promise<CallSession['participants']> {
    const call = await this.calls.findOne({ conversationId, callId }, { participants: 1 }).lean()
    return call?.participants ?? []
  }

  /**
   * Efficient DB count of missed calls for a user since a given date.
   * Used by the notification badge endpoint.
   */
  async countMissedCallsSince(userId: string, since: Date): Promise<number> {
    return this.calls.countDocuments({
      status: 'missed',
      startedAt: { $gte: since },
      $or: [
        { createdBy: userId },
        { 'participants.userId': userId },
      ],
    })
  }

  /**
   * Lightweight patch by callId (used by the POST /calls/history endpoint to
   * stamp the client-reported ended_at when the server-side socket end was
   * not received, e.g. due to a network drop).
   *
   * Only writes endedAt when the call is not already ended, to avoid
   * overwriting the authoritative server-side value.
   */
  async patchCallById(
    callId: string,
    patch: Partial<{ endedAt: Date }>,
  ): Promise<void> {
    if (!callId || !patch.endedAt) return
    await this.calls.updateOne(
      { callId, status: { $ne: 'ended' } },
      { $set: { endedAt: patch.endedAt, isActiveInConversation: false } },
    )
  }

  /**
   * Create a standalone call not tied to any existing conversation.
   * Uses a virtual conversationId = `standalone:${callId}` so all existing
   * socket routing (convRoom) still works without special-casing.
   */
  async createStandaloneCall(args: StandaloneCallArgs): Promise<CallSession & { inviteToken: string }> {
    const inviteToken = crypto.randomBytes(16).toString('hex')
    const conversationId = `standalone:${args.callId}`
    const now = new Date()
    const callType = args.callType ?? 'voice'
    const legacyMedia = callType.startsWith('video') ? 'video' : 'voice'

    const participants: CallParticipant[] = [
      {
        userId: args.createdBy,
        status: 'connecting',
        role: 'host',
        invitedAt: now,
        joinedAt: null,
        leftAt: null,
        reason: null,
      },
    ]

    if (args.inviteeUserIds?.length) {
      for (const uid of args.inviteeUserIds) {
        if (uid === args.createdBy) continue
        participants.push({
          userId: uid,
          status: 'invited',
          role: null,
          invitedAt: now,
          joinedAt: null,
          leftAt: null,
          reason: null,
        })
      }
    }

    const doc = await this.calls.create({
      conversationId,
      callId: args.callId,
      createdBy: args.createdBy,
      status: args.scheduledFor && args.scheduledFor > now ? 'pending' : 'ringing',
      startedAt: now,
      endedAt: null,
      callType,
      media: legacyMedia,
      viewerCount: 0,
      participants,
      signals: [],
      isActiveInConversation: !args.scheduledFor || args.scheduledFor <= now,
      isStandalone: true,
      title: args.title,
      inviteToken,
      scheduledFor: args.scheduledFor ?? null,
      knockingUserIds: [],
    })

    return { ...doc.toObject(), inviteToken }
  }

  /** Resolve an invite token to its call session. */
  async getCallByToken(token: string): Promise<CallSession | null> {
    return this.calls.findOne({ inviteToken: token }).lean()
  }

  /**
   * Generate (or return an existing) invite token for any active call.
   * Standalone calls already have one; for conversation-backed calls we create
   * one on demand and persist it.
   */
  async getOrCreateInviteToken(conversationId: string, callId: string): Promise<string | null> {
    const call = await this.calls.findOne({ conversationId, callId }).lean()
    if (!call) return null
    if (call.status === 'ended' || call.status === 'missed') return null
    if (call.inviteToken) return call.inviteToken

    const token = crypto.randomBytes(16).toString('hex')
    await this.calls.updateOne(
      { conversationId, callId, inviteToken: null },
      { $set: { inviteToken: token } },
    )
    return token
  }

  /** List upcoming scheduled calls for a user. */
  async getScheduledCalls(userId: string): Promise<CallSession[]> {
    const now = new Date()
    return this.calls
      .find({
        scheduledFor: { $gt: now },
        status: 'ringing',
        $or: [{ createdBy: userId }, { 'participants.userId': userId }],
      })
      .sort({ scheduledFor: 1 })
      .limit(50)
      .lean()
  }

  /** Add a user to the knocking list; host will be notified via socket. */
  async addKnocker(conversationId: string, callId: string, userId: string): Promise<void> {
    await this.calls.updateOne(
      { conversationId, callId },
      { $addToSet: { knockingUserIds: userId } },
    )
  }

  /** Remove a user from the knocking list (admitted or denied). */
  async removeKnocker(conversationId: string, callId: string, userId: string): Promise<void> {
    await this.calls.updateOne(
      { conversationId, callId },
      { $pull: { knockingUserIds: userId } },
    )
  }

  /**
   * Return TURN server credentials derived from environment variables.
   * Format: { ice_servers: [{ urls, username, credential }] }
   * Falls back to public STUN if no TURN env is configured.
   */
  getTurnCredentials(): { ice_servers: any[] } {
    const turnUrl = process.env.TURN_URL
    const turnUser = process.env.TURN_USERNAME
    const turnCredential = process.env.TURN_CREDENTIAL

    const servers: any[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]

    if (turnUrl && turnUser && turnCredential) {
      servers.push({ urls: turnUrl, username: turnUser, credential: turnCredential })
      // Also try the UDP variant for poor-network relay
      const udpUrl = turnUrl.replace('turn:', 'turn:').replace('?transport=tcp', '?transport=udp')
      if (udpUrl !== turnUrl) servers.push({ urls: udpUrl, username: turnUser, credential: turnCredential })
    }

    return { ice_servers: servers }
  }

  /** Update recording state and optional URL. */
  async setRecordingState(
    conversationId: string,
    callId: string,
    state: 'idle' | 'recording' | 'stopped',
    url?: string,
  ): Promise<void> {
    const update: any = { recordingState: state }
    if (url) update.recordingUrl = url
    await this.calls.updateOne({ conversationId, callId }, { $set: update })
  }

  /** Start or stop RTMP streaming. */
  async setRtmp(conversationId: string, callId: string, active: boolean, url?: string): Promise<void> {
    const update: any = { rtmpActive: active }
    if (url) update.rtmpUrl = url
    await this.calls.updateOne({ conversationId, callId }, { $set: update })
  }

  /** Return participants who are waiting to join a pending scheduled call. */
  async getWaitingParticipants(conversationId: string, callId: string): Promise<string[]> {
    const call = await this.calls.findOne({ conversationId, callId }, { participants: 1 }).lean()
    return (call?.participants ?? [])
      .filter((p) => p.status === 'invited')
      .map((p) => p.userId)
  }

  async cleanupStaleCalls(): Promise<void> {
    const now = new Date()
    const ringingCutoff  = new Date(now.getTime() -     90_000) // unanswered > 90 s → missed
    const activeCutoff   = new Date(now.getTime() -    120_000) // all-left > 120 s → ended
    const pendingCutoff  = new Date(now.getTime() - 86_400_000) // scheduled but never started > 24 h → missed
    const durationCutoff = new Date(now.getTime() - 86_400_000) // active > 24 h → force-ended

    // ── 1. Unanswered ringing calls → missed ─────────────────────────────────
    const staleRinging = await this.calls
      .find({ status: { $in: ['ringing'] }, startedAt: { $lt: ringingCutoff }, isActiveInConversation: true })
      .lean()
    for (const call of staleRinging) {
      await this.calls.updateOne(
        { conversationId: call.conversationId, callId: call.callId, status: { $ne: 'missed' } },
        { $set: { status: 'missed', endedAt: now, isActiveInConversation: false } },
      )
      this.logger.log(`[calls] cleanup: ringing timeout callId=${call.callId}`)
      if (this._notificationsService) {
        const unanswered = call.participants.filter(
          (p) => p.status === 'invited' || p.status === 'connecting',
        )
        for (const p of unanswered) {
          this._notificationsService.notifyMissedCall({
            toUserId: p.userId,
            fromUserId: call.createdBy,
            conversationId: call.conversationId,
            callId: call.callId,
            callType: call.callType,
          }).catch(() => {})
        }
      }
    }

    // ── 2. Active calls where everyone left → ended ───────────────────────────
    const staleActive = await this.calls
      .find({ status: 'active', isActiveInConversation: true, startedAt: { $lt: activeCutoff } })
      .lean()
    for (const call of staleActive) {
      const anyStillIn = call.participants.some(
        (p) => p.status === 'joined' || p.status === 'connecting',
      )
      if (!anyStillIn) {
        await this.calls.updateOne(
          { conversationId: call.conversationId, callId: call.callId },
          { $set: { status: 'ended', endedAt: now, isActiveInConversation: false } },
        )
        this.logger.log(`[calls] cleanup: abandoned call ended callId=${call.callId}`)
      }
    }

    // ── 3. Calls running > 24 h → force-ended (safety cap) ────────────────────
    const tooLong = await this.calls
      .find({ status: 'active', isActiveInConversation: true, startedAt: { $lt: durationCutoff } })
      .lean()
    for (const call of tooLong) {
      await this.calls.updateOne(
        { conversationId: call.conversationId, callId: call.callId },
        { $set: { status: 'ended', endedAt: now, isActiveInConversation: false } },
      )
      this.logger.warn(`[calls] cleanup: 24-hour cap reached callId=${call.callId}`)
    }

    // ── 4. Pending/scheduled calls that are > 24 h old → missed ──────────────
    const stalePending = await this.calls
      .find({ status: 'pending', startedAt: { $lt: pendingCutoff }, isActiveInConversation: true })
      .lean()
    for (const call of stalePending) {
      await this.calls.updateOne(
        { conversationId: call.conversationId, callId: call.callId },
        { $set: { status: 'missed', endedAt: now, isActiveInConversation: false } },
      )
      this.logger.log(`[calls] cleanup: pending call expired callId=${call.callId}`)
    }
  }
}
