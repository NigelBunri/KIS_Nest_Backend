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
