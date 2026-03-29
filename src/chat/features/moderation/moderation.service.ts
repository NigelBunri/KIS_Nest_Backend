import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  MessageReport,
  ReportDocument,
  ConversationBlock,
  BlockDocument,
  ConversationMute,
  MuteDocument,
} from './moderation.schema';

@Injectable()
export class ModerationService {
  constructor(
    @InjectModel(MessageReport.name) private readonly reports: Model<ReportDocument>,
    @InjectModel(ConversationBlock.name) private readonly blocks: Model<BlockDocument>,
    @InjectModel(ConversationMute.name) private readonly mutes: Model<MuteDocument>,
  ) {}

  async reportMessage(input: {
    conversationId: string;
    messageId: string;
    reportedBy: string;
    reason?: string;
    note?: string;
  }) {
    try {
      await this.reports.create(input);
    } catch (e: any) {
      if (e?.code !== 11000) throw e; // idempotent
    }
    return { ok: true };
  }

  async setBlocked(input: { conversationId: string; userId: string; blocked: boolean }) {
    await this.blocks.updateOne(
      { conversationId: input.conversationId, userId: input.userId },
      { $set: { blocked: input.blocked } },
      { upsert: true },
    );
    return { blocked: input.blocked };
  }

  async setMuted(input: { conversationId: string; userId: string; muted: boolean; untilMs?: number }) {
    await this.mutes.updateOne(
      { conversationId: input.conversationId, userId: input.userId },
      { $set: { muted: input.muted, untilMs: input.untilMs } },
      { upsert: true },
    );
    return { muted: input.muted, untilMs: input.untilMs };
  }

  /**
   * Enforcement: call this before allowing user to act in a conversation.
   * - blocked => forbid all actions
   * - muted  => forbid "send" only (your choice; we enforce send)
   */
  async assertAllowed(input: {
    conversationId: string;
    userId: string;
    action: 'send' | 'edit' | 'delete' | 'react' | 'receipt' | 'typing';
    nowMs?: number;
  }) {
    const now = input.nowMs ?? Date.now();

    const block = await this.blocks.findOne({ conversationId: input.conversationId, userId: input.userId });
    if (block?.blocked) throw new ForbiddenException('blocked');

    if (input.action === 'send') {
      const mute = await this.mutes.findOne({ conversationId: input.conversationId, userId: input.userId });
      if (mute?.muted) {
        if (!mute.untilMs || mute.untilMs > now) throw new ForbiddenException('muted');
      }
    }
  }
}
