import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Pin, PinDocument } from './pin.schema';

@Injectable()
export class PinsService {
  constructor(
    @InjectModel(Pin.name) private readonly pinModel: Model<PinDocument>,
  ) {}

  /**
   * Idempotent pin/unpin.
   * Returns the resulting pinned state.
   */
  async setPinned(input: {
    conversationId: string;
    messageId: string;
    userId: string;
    pinned: boolean;
  }): Promise<{ pinned: boolean }> {
    const { conversationId, messageId, userId, pinned } = input;

    if (pinned) {
      try {
        await this.pinModel.create({
          conversationId,
          messageId,
          pinnedBy: userId,
        });
      } catch (e: any) {
        // ignore duplicate key errors (idempotent)
        if (e?.code !== 11000) throw e;
      }
      return { pinned: true };
    }

    await this.pinModel.deleteOne({ conversationId, messageId });
    return { pinned: false };
  }

  /**
   * Optional helper: list pinned message IDs (most recent first).
   * Useful for client bootstrap or "Pinned messages" screen.
   */
  async listPinnedMessageIds(input: {
    conversationId: string;
    limit?: number;
    before?: string; // ISO date string
  }): Promise<{ messageIds: string[] }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    const q: any = { conversationId: input.conversationId };
    if (input.before) q.createdAt = { $lt: new Date(input.before) };

    const rows = await this.pinModel
      .find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select({ messageId: 1 });

    return { messageIds: rows.map(r => String(r.messageId)) };
  }
}
