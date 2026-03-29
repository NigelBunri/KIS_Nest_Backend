import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Star, StarDocument } from './star.schema';

@Injectable()
export class StarsService {
  constructor(
    @InjectModel(Star.name) private readonly starModel: Model<StarDocument>,
  ) {}

  /**
   * Idempotent set/unset starred state.
   * Returns the resulting state.
   */
  async setStarred(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    starred: boolean;
  }): Promise<{ starred: boolean }> {
    const { userId, conversationId, messageId, starred } = input;

    if (starred) {
      // create if missing
      try {
        await this.starModel.create({ userId, conversationId, messageId });
      } catch (e: any) {
        // ignore duplicate key errors (idempotent)
        if (e?.code !== 11000) throw e;
      }
      return { starred: true };
    }

    // remove if exists
    await this.starModel.deleteOne({ userId, conversationId, messageId });
    return { starred: false };
  }

  /**
   * Optional helper for client bootstrap:
   * list starred messageIds for a conversation (most recent first).
   */
  async listStarredMessageIds(input: {
    userId: string;
    conversationId: string;
    limit?: number;
    before?: string; // ISO date string for pagination
  }): Promise<{ messageIds: string[] }> {
    const { userId, conversationId } = input;
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);

    const q: any = { userId, conversationId };
    if (input.before) q.createdAt = { $lt: new Date(input.before) };

    const rows = await this.starModel
      .find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select({ messageId: 1 });

    return { messageIds: rows.map(r => String(r.messageId)) };
  }
}
