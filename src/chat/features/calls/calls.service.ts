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
  CallStatus,
} from './schemas/call-session.schema'

type UpsertCallArgs = {
  conversationId: string
  callId: string
  createdBy: string
  createdByDisplayName?: string
  createdByPhone?: string
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
    fromPhone?: string
    conversationId: string
    callId: string
    callType?: string
  }): Promise<any>
}

// ─── Call state machine ──────────────────────────────────────────────────
//
// Authoritative states a CallSession.status can hold, and the only
// transitions allowed between them. Every write below that changes
// `status` is expressed as an atomic Mongo query that only matches
// documents currently in an allowed "from" state — never a read-then-write
// — so two concurrent requests (e.g. a duplicate call.answer, or a
// call.end racing the stale-ringing reaper) can't both succeed and leave
// the record in an inconsistent state.
//
//   pending → ringing | missed | ended
//   ringing → active | missed | ended
//   active  → ended
//   missed  → (terminal)
//   ended   → (terminal)
//
// In particular: an `active` call (someone actually answered) is NEVER
// auto-ended by age alone, only by every participant actually leaving
// (cleanupStaleCalls, participant-aware) or an explicit call.end. This was
// previously violated — see createCallOrThrowIfActiveInConversation below.
const RINGING_STALE_MS = 90 * 1000 // matches cleanupStaleCalls' ringingCutoff

@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name)
  private cleanupTimer?: NodeJS.Timeout
  private _notificationsService?: NotificationsServiceRef
  // Grace timers for participants whose socket disconnected — a brief
  // network blip or app backgrounding shouldn't end the call the instant a
  // socket drops. Keyed by conversationId:callId:userId.
  private disconnectGraceTimers = new Map<string, NodeJS.Timeout>()

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
    for (const timer of this.disconnectGraceTimers.values()) clearTimeout(timer)
    this.disconnectGraceTimers.clear()
  }

  private disconnectGraceKey(conversationId: string, callId: string, userId: string): string {
    return `${conversationId}:${callId}:${userId}`
  }

  /**
   * Defer "this participant left" cleanup by `graceMs` instead of acting on a
   * socket disconnect immediately. A brief network blip, an app backgrounded
   * briefly, or a socket.io reconnect cycle would otherwise be treated
   * identically to an explicit call.leave and could end a 1:1 call outright.
   * If the same participant reconnects and cancels the timer before it fires
   * (see cancelDisconnectGrace), `onExpire` never runs.
   */
  scheduleDisconnectGrace(
    conversationId: string,
    callId: string,
    userId: string,
    onExpire: () => void | Promise<void>,
    graceMs = 20_000,
  ): void {
    this.cancelDisconnectGrace(conversationId, callId, userId)
    const key = this.disconnectGraceKey(conversationId, callId, userId)
    const timer = setTimeout(() => {
      this.disconnectGraceTimers.delete(key)
      Promise.resolve(onExpire()).catch((e: any) =>
        this.logger.warn('[calls] disconnect-grace expiry failed', e?.message),
      )
    }, graceMs)
    this.disconnectGraceTimers.set(key, timer)
  }

  /** Cancel a pending disconnect-grace timer. Returns true if one was pending. */
  cancelDisconnectGrace(conversationId: string, callId: string, userId: string): boolean {
    const key = this.disconnectGraceKey(conversationId, callId, userId)
    const timer = this.disconnectGraceTimers.get(key)
    if (!timer) return false
    clearTimeout(timer)
    this.disconnectGraceTimers.delete(key)
    return true
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

  async createCallOrThrowIfActiveInConversation(
    args: UpsertCallArgs,
  ): Promise<CallSession & { __reused?: boolean }> {
    // Idempotent: same callId was already created (reconnect / duplicate emit) — return it.
    const existingById = await this.calls
      .findOne({ conversationId: args.conversationId, callId: args.callId })
      .lean()
    if (existingById) {
      // A terminal call (already ended/missed) must never be resurrected by
      // a late/duplicate call.offer — e.g. a queued socket emit that only
      // gets flushed after a reconnect, well after the reaper or an
      // explicit call.end already closed it out. Rejecting here (rather
      // than the old behavior of returning it as "reused") stops the
      // handler from re-broadcasting call.offer/pushing invitees for a call
      // that's genuinely over.
      if (existingById.status === 'ended' || existingById.status === 'missed') {
        this.logger.debug(
          `[calls] createCall rejected: callId=${args.callId} already terminal (${existingById.status})`,
        )
        throw new Error('CALL_ALREADY_ENDED')
      }
      this.logger.debug(`[calls] createCall idempotent return callId=${args.callId}`)
      // __reused tells the caller this call.offer was already processed once —
      // e.g. a client resent it after a socket reconnect — so it must not
      // send a second round of incoming-call push notifications.
      return { ...(existingById as CallSession), __reused: true }
    }

    // If another call is active for this conversation, only a still-RINGING
    // one that's been unanswered past the ring window is eligible for
    // auto-cleanup — matching cleanupStaleCalls' own ringingCutoff. This
    // handles call.end never arriving (network drop, app kill, a recipient
    // whose call never surfaced while backgrounded).
    //
    // CRITICAL: an `active` call (someone actually answered) must NEVER be
    // auto-ended by age alone — a real, ongoing call is very commonly older
    // than any short ring-timeout. A prior version of this check used a
    // flat age threshold regardless of status, which meant a duplicate/
    // stray call.offer arriving mid-conversation could silently end a
    // call two people were actively talking on. Only call.end, call.leave,
    // or cleanupStaleCalls' participant-aware reaper (which checks who's
    // actually still joined, not just elapsed time) may end an active call.
    const existingActive = await this.calls
      .findOne({ conversationId: args.conversationId, isActiveInConversation: true })
      .lean()
    if (existingActive) {
      const ageMs = Date.now() - new Date(existingActive.startedAt).getTime()
      const staleRinging = existingActive.status === 'ringing' && ageMs > RINGING_STALE_MS
      if (!staleRinging) {
        throw new Error('CALL_ALREADY_ACTIVE')
      }
      // Atomic: only flip it if it's STILL 'ringing' at write time. If it
      // was answered in the race window between our read and this update,
      // modifiedCount is 0 and we correctly fall through to
      // CALL_ALREADY_ACTIVE instead of clobbering a call that just connected.
      const result = await this.calls.updateOne(
        { conversationId: args.conversationId, callId: existingActive.callId, status: 'ringing' },
        { $set: { status: 'missed', endedAt: new Date(), isActiveInConversation: false } },
      )
      if (!result.modifiedCount) {
        throw new Error('CALL_ALREADY_ACTIVE')
      }
      this.logger.warn(
        `[calls] auto-missed stale ringing call callId=${existingActive.callId} ageMs=${ageMs}`,
      )
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
        createdByDisplayName: args.createdByDisplayName ?? null,
        createdByPhone: args.createdByPhone ?? null,
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

  /**
   * Atomically mark a call active, but ONLY if it isn't already terminal.
   *
   * Matches status 'ringing' (the normal first-answer transition) OR
   * already 'active' (a later participant joining an in-progress group
   * call) — both are legitimate. Returns null for 'ended'/'missed'/
   * nonexistent, which the caller (call.answer handler) must treat as a
   * STALE ANSWER and reject outright: without this, a late call.answer for
   * a call the server already closed out (e.g. the ring timeout fired
   * before a delayed push finally reached the callee) would still be
   * accepted client-side, since nothing previously checked this result.
   */
  async markActive(conversationId: string, callId: string): Promise<CallSession | null> {
    return this.calls
      .findOneAndUpdate(
        { conversationId, callId, status: { $in: ['ringing', 'active'] } },
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

    // Already terminal — a concurrent writer (the stale-ringing reaper in
    // cleanupStaleCalls, or a duplicate/retried call.end for this callId)
    // already closed this call out. Still record this participant's own
    // exit for history, but don't re-transition the call or re-fire
    // missed-call notifications: whichever write actually performed the
    // transition already claimed that responsibility (see the CAS below).
    if (call.status === 'ended' || call.status === 'missed') {
      await this.setParticipantStatus(conversationId, callId, endedByUserId, 'left', reason)
      return this.calls.findOne({ conversationId, callId }).lean()
    }

    // Authoritative classification: a call nobody ever joined, ending while
    // still 'ringing', is a missed call for every invitee still invited/
    // connecting — independent of the free-text `reason` the client sent.
    // This is deliberately NOT a reason-string whitelist: the mobile app
    // has several distinct code paths that end an unanswered call (an
    // explicit cancel via endCallForAll, a decline, the client-side ring
    // timeout), and they don't all send the same reason string (e.g.
    // endCallForAll sends 'ended_by_host' even when used to cancel an
    // outgoing call nobody has joined yet). A whitelist here previously
    // caused caller-cancel to silently produce no missed-call push at all
    // for any reason string it didn't happen to recognize. Participant
    // state — was anyone ever actually joined — is the only reliable
    // signal for "was this call missed".
    const anyJoined = call.participants.some((p) => p.status === 'joined')
    const terminalStatus: CallStatus = !anyJoined && call.status === 'ringing' ? 'missed' : 'ended'

    // Compare-and-swap on the status just read — guards the same race
    // cleanupStaleCalls' own updateOne guards against: if a concurrent
    // writer (the reaper, or a duplicate call.end) already moved this
    // call's status since the read above, this matches nothing and
    // `updated` is null, so this invocation must not notify (whichever
    // write actually won already did, or will).
    const updated = await this.calls
      .findOneAndUpdate(
        { conversationId, callId, status: call.status },
        { $set: { status: terminalStatus, endedAt: now, isActiveInConversation: false } },
        { new: true },
      )
      .lean()

    await this.setParticipantStatus(conversationId, callId, endedByUserId, 'left', reason)

    if (!updated) {
      // Lost the race. Return current state without notifying — the
      // winning writer already claimed (or will claim) that job.
      return this.calls.findOne({ conversationId, callId }).lean()
    }

    // Deliberately NOT gated on terminalStatus === 'missed': that call-level
    // classification answers "did anyone ever join this call" (controls the
    // persisted status / call-history badge), which is a different question
    // from "did THIS specific invitee ever answer" in a group call. A group
    // call where one invitee joined and two never answered is correctly
    // classified 'ended' overall (someone WAS reached), but the two who
    // were never answered still each get their own missed-call push.
    if (this._notificationsService) {
      const unanswered = updated.participants.filter(
        (p) =>
          p.userId !== endedByUserId &&
          // The call's own creator is tracked as a participant with status
          // 'connecting' from the moment they place the call, and nothing
          // ever transitions it to 'joined' (there's no "the caller
          // answered their own call" event) — so without this exclusion, a
          // creator who ends their own live, fully-answered 1:1 call would
          // match the invited/connecting filter below and get a "missed
          // call" push about the call they just made themselves.
          p.userId !== updated.createdBy &&
          (p.status === 'invited' || p.status === 'connecting'),
      )
      for (const p of unanswered) {
        this._notificationsService
          .notifyMissedCall({
            toUserId: p.userId,
            fromUserId: updated.createdBy,
            fromDisplayName: (updated as any).createdByDisplayName ?? undefined,
            fromPhone: (updated as any).createdByPhone ?? undefined,
            conversationId,
            callId,
            callType: updated.callType,
          })
          .catch(() => {})
      }
    }

    return updated
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
    if (!call || call.status === 'ended' || call.status === 'missed') return

    const anyStillIn =
      call.participants.some((p) => p.status === 'joined' || p.status === 'connecting' || p.status === 'invited')

    if (!anyStillIn) {
      // Same classification rule as endCall(): nobody ever joined this
      // call → it was missed, not merely "ended", even though every
      // invitee got there by declining/busy rather than an explicit
      // cancel. No one is left in invited/connecting state at this point
      // (that's this branch's own precondition), so there's no remaining
      // invitee to push a missed-call notification to here.
      const anyJoined = call.participants.some((p) => p.status === 'joined')
      const terminalStatus: CallStatus = !anyJoined && call.status === 'ringing' ? 'missed' : 'ended'
      await this.calls.updateOne(
        { conversationId, callId, status: call.status },
        { $set: { status: terminalStatus, endedAt: new Date(), isActiveInConversation: false } },
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
   * overwriting the authoritative server-side value. requestingUserId is
   * matched against createdBy/participants in the SAME atomic query as the
   * write, so an authenticated user who was never on this call (guessed or
   * leaked callId) cannot tamper with its end metadata - the update simply
   * matches zero documents for them instead.
   */
  async patchCallById(
    callId: string,
    requestingUserId: string,
    patch: Partial<{ endedAt: Date }>,
  ): Promise<void> {
    if (!callId || !requestingUserId || !patch.endedAt) return
    await this.calls.updateOne(
      {
        callId,
        status: { $ne: 'ended' },
        $or: [{ createdBy: requestingUserId }, { 'participants.userId': requestingUserId }],
      },
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
      // Guard against duplicate missed-call pushes if this tick overlaps a
      // still-running previous tick (cleanupStaleCalls has no run-time cap
      // relative to the 30s interval) or another server instance runs the
      // same cleanup concurrently: only the update that actually flips the
      // status away from 'missed' is allowed to notify.
      const result = await this.calls.updateOne(
        { conversationId: call.conversationId, callId: call.callId, status: { $ne: 'missed' } },
        { $set: { status: 'missed', endedAt: now, isActiveInConversation: false } },
      )
      if (!result.modifiedCount) continue
      this.logger.log(`[calls] cleanup: ringing timeout callId=${call.callId}`)
      if (this._notificationsService) {
        const unanswered = call.participants.filter(
          // Exclude the call's own creator — see the identical exclusion
          // (and its full rationale) in endCall(). Without it, a 1:1 call
          // nobody answered would notify the CALLER that they missed their
          // own outgoing call, since the creator's participant row is
          // permanently 'connecting' and otherwise matches this filter too.
          (p) => p.userId !== call.createdBy && (p.status === 'invited' || p.status === 'connecting'),
        )
        for (const p of unanswered) {
          this._notificationsService.notifyMissedCall({
            toUserId: p.userId,
            fromUserId: call.createdBy,
            // The ring-timeout path (every call nobody answered in 90s —
            // the single most common "missed call" scenario) previously
            // omitted the caller's identity entirely, so this push always
            // fell through notifyMissedCall's own fallback. Captured once
            // at call.offer time (see createCallOrThrowIfActiveInConversation)
            // since the caller is typically long gone from any live socket
            // by the time this reaper tick runs.
            fromDisplayName: (call as any).createdByDisplayName ?? undefined,
            fromPhone: (call as any).createdByPhone ?? undefined,
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
