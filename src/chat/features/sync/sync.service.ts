// src/chat/features/sync/sync.service.ts

import { Injectable } from '@nestjs/common'
import { MessagesService } from '../messages/messages.service'

@Injectable()
export class SyncService {
  constructor(private readonly messages: MessagesService) {}

  // ✅ required by realtime handlers
  async findMissingSeqs(args: { conversationId: string; haveSeqs: number[] }): Promise<number[]> {
    return this.messages.findMissingSeqs(args)
  }

  // ✅ required by realtime handlers
  async getRange(args: { conversationId: string; seqs: number[] }): Promise<any[]> {
    return this.messages.getRange(args)
  }

  // (Optional) Keep your old API if something else uses it
  async gapRepair(conversationId: string, fromSeq: number, toSeq: number) {
    const haveSeqs: number[] = []
    for (let s = fromSeq; s <= toSeq; s++) haveSeqs.push(s)


    const missing = await this.findMissingSeqs({ conversationId, haveSeqs })
    const messages = await this.getRange({ conversationId, seqs: missing })
    return { missing, messages }
  }
}
