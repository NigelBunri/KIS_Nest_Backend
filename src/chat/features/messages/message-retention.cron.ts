// src/chat/features/messages/message-retention.cron.ts
//
// Scrubs content from messages that have sat isDeleted=true (a user's own
// "delete for everyone", deleteMessageLegacy) for longer than the
// retention window - that path only ever flips isDeleted/deleteState and
// leaves the real content (including E2EE ciphertext) in Mongo forever,
// hidden from clients but not actually gone. See
// MessagesService.scrubContentForMessagesDeletedBefore's docstring.

import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { MessagesService } from './messages.service'

const DEFAULT_RETENTION_DAYS = 30

@Injectable()
export class MessageRetentionCron {
  private readonly logger = new Logger(MessageRetentionCron.name)

  constructor(private readonly messagesService: MessagesService) {}

  @Cron('0 3 * * *')
  async scrubOldDeletedMessages() {
    const retentionDays = Number(process.env.MESSAGE_DELETED_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    try {
      const { scrubbed } = await this.messagesService.scrubContentForMessagesDeletedBefore(cutoffMs)
      if (scrubbed > 0) {
        this.logger.log(`[retention] scrubbed content for ${scrubbed} message(s) deleted before ${retentionDays}d ago`)
      }
    } catch (e: any) {
      this.logger.error('[retention] scrubContentForMessagesDeletedBefore failed', e?.stack ?? e?.message)
    }
  }
}
