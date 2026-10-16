import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Pin, PinDocument } from './pin.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';

@Injectable()
export class PinsService {
  constructor(
    @InjectModel(Pin.name) private readonly pinModel: Model<PinDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
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

    // Confirmed gap (2026-10-16): nothing here ever verified messageId
    // actually belongs to conversationId - the controller/socket handler
    // only check that the CALLER is a member of conversationId, which
    // says nothing about which conversation the message itself is in. A
    // member could otherwise pin an arbitrary message id, including one
    // from a conversation they have no access to at all.
    const message = await this.messageModel.findOne({
      _id: messageId,
      conversationId,
    });
    if (!message) {
      throw new NotFoundException('message not found in this conversation');
    }
    if ((message as any).isDeleted) {
      throw new BadRequestException('cannot pin a deleted message');
    }

    if (pinned) {
      // Idempotent by construction (atomic upsert), not by relying on a
      // duplicate-key exception from the unique(conversationId,
      // messageId) index - that index is declared on the schema, but
      // Mongoose's autoIndex is disabled in production (see
      // app.module.ts), so it is only actually present if something
      // created it out-of-band. $setOnInsert ensures a genuinely
      // concurrent pin by two different callers converges to exactly one
      // document (pinnedBy = whichever request's upsert wins) either way.
      await this.pinModel.updateOne(
        { conversationId, messageId },
        { $setOnInsert: { conversationId, messageId, pinnedBy: userId } },
        { upsert: true },
      );
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
