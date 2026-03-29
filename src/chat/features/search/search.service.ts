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

    const filter: any = { conversationId: input.conversationId, $text: { $search: input.q } };
    if (input.threadId) filter.threadId = input.threadId;

    const rows = await this.messages
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
      .skip(skip)
      .limit(limit);

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
