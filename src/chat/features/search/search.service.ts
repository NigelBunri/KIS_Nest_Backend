import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message, MessageDocument } from '../messages/schemas/message.schema';

@Injectable()
export class SearchService {
  constructor(
    @InjectModel(Message.name) private readonly messages: Model<MessageDocument>,
  ) {}

  async searchConversationMessages(input: {
    conversationId: string;
    q: string;
    limit?: number;
    skip?: number;
    threadId?: string;
  }) {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const skip = Math.min(Math.max(input.skip ?? 0, 0), 5000);

    const baseFilter: any = { conversationId: input.conversationId, isDeleted: { $ne: true } };
    if (input.threadId) baseFilter.threadId = input.threadId;

    let rows = await this.messages
      .find({ ...baseFilter, $text: { $search: input.q } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (!rows.length) {
      const escaped = input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      rows = await this.messages
        .find({
          ...baseFilter,
          $or: [{ text: regex }, { previewText: regex }, { 'styledText.text': regex }],
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
    }

    return {
      results: rows.map((m: any) => ({
        id: String(m._id),
        conversationId: m.conversationId,
        threadId: m.threadId,
        seq: m.seq,
        clientId: m.clientId,
        senderId: m.senderId,
        kind: m.kind,
        text: m.text,
        previewText: m.previewText,
        createdAt: m.createdAt?.toISOString?.() ?? m.createdAt,
      })),
    };
  }
}
