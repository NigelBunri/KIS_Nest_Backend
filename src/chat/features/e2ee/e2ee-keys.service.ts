import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import {
  ConversationKey,
  ConversationKeyDocument,
} from './schemas/conversation-key.schema'

export type ConversationKeyEntry = {
  key: string
  version: string
}

// custom-aes-2 is a retired, server-held-symmetric-key E2EE scheme that
// predates the Signal Protocol pairwise fan-out (security/e2ee.ts on the
// client) every message encrypts with today. The client's own encrypt path
// for this scheme is already gone (security/customE2EE.ts is read-only/
// legacy-decrypt — see its own comment); this service exists ONLY so a
// client can still decrypt messages that were encrypted under this scheme
// BEFORE that migration, which are still sitting in message history.
//
// Defect D2 (KIS_E2EE_KEY_LIFECYCLE_AUDIT.md): this used to silently
// GENERATE a brand-new random AES key for any conversationId with none on
// file, then hand that plaintext key to any authorized member via the GET
// endpoint below. Since nothing ever encrypts with this scheme anymore, a
// freshly-minted key could never decrypt anything real — it only expanded
// the set of plaintext symmetric keys sitting in Mongo and reachable over
// the network for no functional benefit. getExistingKey() below never
// creates a key; a conversation either already has genuine legacy
// ciphertext on file (so its key already exists, created back when this
// scheme was still live) or it has none, in which case there is nothing
// for a client to ever legitimately decrypt here.
@Injectable()
export class E2eeKeysService {
  private readonly logger = new Logger(E2eeKeysService.name)

  constructor(
    @InjectModel(ConversationKey.name)
    private readonly keyModel: Model<ConversationKeyDocument>,
  ) {}

  async getExistingKey(conversationId: string): Promise<ConversationKeyEntry | null> {
    const existing = await this.keyModel
      .findOne({ conversationId })
      .lean()
      .exec()

    if (!existing?.key || !existing?.version) {
      return null
    }
    return { key: existing.key, version: existing.version }
  }
}
