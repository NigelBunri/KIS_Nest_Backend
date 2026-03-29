import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { createDecipheriv, randomBytes, randomUUID } from 'crypto'

import type { SendMessagePayload } from '../../chat.types'
import {
  ConversationKey,
  ConversationKeyDocument,
} from './schemas/conversation-key.schema'

export type ConversationKeyEntry = {
  key: string
  version: string
}

@Injectable()
export class E2eeKeysService {
  private readonly logger = new Logger(E2eeKeysService.name)

  constructor(
    @InjectModel(ConversationKey.name)
    private readonly keyModel: Model<ConversationKeyDocument>,
  ) {}

  async ensureKey(conversationId: string): Promise<ConversationKeyEntry> {
    const existing = await this.keyModel
      .findOne({ conversationId })
      .lean()
      .exec()

    if (existing?.key && existing?.version) {
      return { key: existing.key, version: existing.version }
    }

    const key = existing?.key ?? randomBytes(32).toString('base64')
    const version = existing?.version ?? randomUUID()

    if (existing) {
      await this.keyModel.updateOne({ conversationId }, { version })
      return { key, version }
    }

    const created = await new this.keyModel({ conversationId, key, version }).save()
    this.logger.log(
      `generated E2EE key for conversationId=${conversationId} id=${created._id} version=${version}`,
    )
    return { key, version }
  }

  async decryptMessagePayload(
    conversationId: string,
    payload: SendMessagePayload,
  ): Promise<void> {
    if (
      !payload.encrypted ||
      !payload.ciphertext ||
      !payload.iv ||
      !payload.tag
    ) {
      return
    }

    const { key: keyBase64, version: storedVersion } = await this.ensureKey(conversationId)
    const key = Buffer.from(keyBase64, 'base64')
    const iv = Buffer.from(payload.iv, 'base64')
    const tag = Buffer.from(payload.tag, 'base64')
    const ciphertext = Buffer.from(payload.ciphertext, 'base64')

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    const providedVersion = payload.encryptionKeyVersion ?? payload.encryptionVersion
    if (providedVersion && providedVersion !== storedVersion) {
      this.logger.warn(
        `[E2eeKeysService] key version mismatch conversationId=${conversationId} payloadVersion=${providedVersion} storedVersion=${storedVersion}`,
      )
    }

    const aadBase64 = payload.aad
    if (aadBase64) {
      try {
        const aad = Buffer.from(aadBase64, 'base64')
        if (aad.length) {
          decipher.setAAD(aad)
        }
      } catch {
        this.logger.warn(
          `[E2eeKeysService] invalid AAD for conversationId=${conversationId}`,
        )
      }
    }

    let decrypted: Buffer
    try {
      decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch (error: any) {
      this.logger.error(
        `failed to decrypt message for conversationId=${conversationId} clientId=${payload.clientId}`,
        error?.stack ?? error?.message ?? error,
      )
      throw error
    }

    let parsed: any = null
    try {
      parsed = JSON.parse(decrypted.toString('utf8'))
    } catch {}

    if (parsed && typeof parsed === 'object') {
      Object.assign(payload, parsed)
    }

    payload.encrypted = false
    delete payload.ciphertext
    delete payload.iv
    delete payload.tag
    delete (payload as any).encryptionVersion
    delete (payload as any).encryptionKeyVersion
    delete (payload as any).aad
  }
}
