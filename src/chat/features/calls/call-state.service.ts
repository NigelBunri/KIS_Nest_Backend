import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallState, CallStateDocument, CallLifecycleState } from './schemas/call-state.schema';

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
