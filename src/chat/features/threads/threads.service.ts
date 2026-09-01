import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Thread, ThreadDocument } from './thread.schema';

@Injectable()
export class ThreadsService {
  constructor(
    @InjectModel(Thread.name) private readonly threadModel: Model<ThreadDocument>,
  ) {}

  async createThread(input: {
    conversationId: string;
    rootMessageId: string;
    createdBy: string;
    title?: string;
  }): Promise<ThreadDocument> {
    const { conversationId, rootMessageId, createdBy, title } = input;
    if (!conversationId || !rootMessageId) {
      throw new BadRequestException('conversationId and rootMessageId are required');
    }

    // Idempotent: if thread already exists for rootMessageId return it
    const existing = await this.threadModel.findOne({ conversationId, rootMessageId });
    if (existing) return existing;

    try {
      return await this.threadModel.create({
        conversationId,
        rootMessageId,
        createdBy,
        title,
      });
    } catch (e: any) {
      // race-safe
      if (e?.code === 11000) {
        const again = await this.threadModel.findOne({ conversationId, rootMessageId });
        if (again) return again;
      }
      throw e;
    }
  }

  /**
   * Read-only lookup used by callers (see realtime/handlers/groups.ts) to
   * discover which conversation a threadId belongs to BEFORE doing anything
   * mutating with it, so they can run a membership check against that
   * conversation first.
   */
  async getThreadConversationId(threadId: string): Promise<string | null> {
    if (!threadId) return null;
    const thread = await this.threadModel.findById(threadId).select('conversationId').lean();
    return thread?.conversationId ?? null;
  }

  async renameThread(input: {
    threadId: string;
    // Required and matched against in the query filter below (not just used
    // for logging) - this is what actually ties the rename to the
    // conversation the caller was checked as a member of. A caller must
    // resolve this via getThreadConversationId() and assertMember() against
    // it first (see realtime/handlers/groups.ts's SUBROOM_RENAME handler).
    conversationId: string;
    title: string;
    requestedByUserId: string;
  }): Promise<{ id: string; conversationId: string; title: string }> {
    const { threadId, conversationId, title } = input;
    if (!threadId || !title || !conversationId) {
      throw new BadRequestException('threadId, conversationId and title are required');
    }

    const updated = await this.threadModel.findOneAndUpdate(
      { _id: threadId, conversationId },
      { $set: { title } },
      { new: true },
    );

    if (!updated) {
      throw new BadRequestException(`Thread ${threadId} not found`);
    }

    return {
      id: String(updated._id),
      conversationId: updated.conversationId,
      title: updated.title ?? title,
    };
  }

  async listThreads(input: {
    conversationId: string;
    limit?: number;
    before?: string; // ISO date
  }): Promise<{ threads: Array<{ id: string; rootMessageId: string; title?: string; createdBy: string; createdAt: string }> }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    const q: any = { conversationId: input.conversationId };
    if (input.before) q.createdAt = { $lt: new Date(input.before) };

    const rows = await this.threadModel
      .find(q)
      .sort({ createdAt: -1 })
      .limit(limit);

    return {
      threads: rows.map((t) => ({
        id: String(t._id),
        rootMessageId: t.rootMessageId,
        title: t.title,
        createdBy: t.createdBy,
        createdAt: (t as any).createdAt?.toISOString?.() ?? String((t as any).createdAt),
      })),
    };
  }
}
