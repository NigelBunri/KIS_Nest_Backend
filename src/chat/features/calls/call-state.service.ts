import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallState, CallStateDocument, CallLifecycleState } from './schemas/call-state.schema';

/**
 * UNUSED — found during the KIS calling-system audit (see
 * docs/calling/CALLING_SYSTEM_AUDIT.md). `CallStateModule` is still
 * imported into `chat.module.ts`, so this service IS DI-registered and
 * its `call_states` Mongo collection still exists — but `upsertState`/
 * `listConversationCalls` have zero callers anywhere in `src/` outside
 * this file (verified via `grep -rn "CallStateService" src`). The real,
 * actively-written call-session model is `CallSession`
 * (schemas/call-session.schema.ts) via `CallsService`, which supersedes
 * this one — this schema's singular `fromUserId`/`toUserId` shape
 * predates group-call support and can't represent one.
 *
 * Not deleted in the audit pass: removing a persisted-data-backed module
 * from a production backend without the owner's explicit sign-off felt
 * like the wrong call to make unilaterally, even though no live code
 * path depends on it. If you're reading this and confirming nothing
 * external (an ops script, a dashboard query) reads the `call_states`
 * collection, this service/schema/module and its DI registration in
 * chat.module.ts are safe to delete outright.
 */
@Injectable()
export class CallStateService {
  constructor(
    @InjectModel(CallState.name) private readonly model: Model<CallStateDocument>,
  ) {}

  async upsertState(input: {
    conversationId: string;
    callId: string;
    fromUserId: string;
    toUserId: string;
    state: CallLifecycleState;
    startedAtMs?: number;
    endedAtMs?: number;
    endedReason?: string;
  }) {
    const { conversationId, callId } = input;

    await this.model.updateOne(
      { conversationId, callId },
      {
        $setOnInsert: {
          conversationId,
          callId,
        },
        $set: {
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          state: input.state,
          startedAtMs: input.startedAtMs,
          endedAtMs: input.endedAtMs,
          endedReason: input.endedReason,
        },
      },
      { upsert: true },
    );

    return { ok: true };
  }

  async listConversationCalls(input: {
    conversationId: string;
    limit?: number;
    before?: string; // ISO date string
  }) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const q: any = { conversationId: input.conversationId };
    if (input.before) q.createdAt = { $lt: new Date(input.before) };

    const rows = await this.model.find(q).sort({ createdAt: -1 }).limit(limit);

    return {
      calls: rows.map(r => ({
        id: String(r._id),
        conversationId: r.conversationId,
        callId: r.callId,
        fromUserId: r.fromUserId,
        toUserId: r.toUserId,
        state: r.state,
        startedAtMs: r.startedAtMs,
        endedAtMs: r.endedAtMs,
        endedReason: r.endedReason,
        createdAt: (r as any).createdAt?.toISOString?.() ?? String((r as any).createdAt),
      })),
    };
  }
}
