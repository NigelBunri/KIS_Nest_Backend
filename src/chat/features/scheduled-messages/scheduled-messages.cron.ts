// src/chat/features/scheduled-messages/scheduled-messages.cron.ts
//
// REQUIRES: npm install @nestjs/schedule
// After installing, import ScheduleModule.forRoot() in scheduled-messages.module.ts
// and add this class to the providers array there.

import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Server } from 'socket.io'
import { ScheduledMessagesService } from './scheduled-messages.service'
import { EVT, rooms } from '../../chat.types'

@Injectable()
export class ScheduledMessagesCron {
  private readonly logger = new Logger(ScheduledMessagesCron.name)
  private server?: Server

  constructor(private readonly scheduledMessagesService: ScheduledMessagesService) {}

  /** Called once by the gateway after it initialises so the cron has a server reference */
  setServer(server: Server) {
    this.server = server
  }

  @Cron('*/30 * * * * *')
  async deliverDueMessages() {
    if (!this.server) return
    try {
      const due = await this.scheduledMessagesService.pollDue()
      if (!due.length) return

      for (const msg of due) {
        const conversationId = (msg as any).conversationId
        if (!conversationId) continue

        const idStr = (msg as any)._id?.toString() ?? String((msg as any)._id)
        const dto = {
          ...((msg as any).toObject ? (msg as any).toObject() : msg),
          id: idStr,
          _id: idStr,
        }

        try {
          this.server.to(rooms.convRoom(conversationId)).emit(EVT.MESSAGE, dto)
          this.logger.log(`[scheduled] delivered messageId=${idStr} conversationId=${conversationId}`)
        } catch (emitErr: any) {
          this.logger.warn(`[scheduled] emit failed messageId=${idStr}`, emitErr?.message)
        }
      }
    } catch (e: any) {
      this.logger.error('[scheduled] pollDue failed', e?.stack ?? e?.message)
    }
  }
}
