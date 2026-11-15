// Regression coverage for Defect D2 (KIS_E2EE_KEY_LIFECYCLE_AUDIT.md):
// E2eeKeysService.ensureKey() used to silently GENERATE a brand-new random
// AES-256 key for any conversationId with no key on file, then hand that
// plaintext key to any authorized conversation member via the GET
// /api/v1/e2ee/conversations/:id/key endpoint. Nothing encrypts with this
// retired custom-aes-2 scheme anymore (security/customE2EE.ts on the
// client is read-only/legacy-decrypt), so a freshly-minted key could never
// decrypt anything real - it only grew the set of plaintext symmetric keys
// sitting in Mongo for no functional benefit. getExistingKey() replaces it:
// it must return an existing key (still needed to decrypt genuine
// pre-migration message history) but must NEVER create one.

import { Model, connect, Connection } from 'mongoose'
import {
  ConversationKey,
  ConversationKeySchema,
  ConversationKeyDocument,
} from './schemas/conversation-key.schema'
import { E2eeKeysService } from './e2ee-keys.service'

const TEST_MONGO_URI =
  process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/kis_nest_e2ee_keys_test'

describe('E2eeKeysService.getExistingKey (real Mongo)', () => {
  let mongoConnection: Connection
  let keyModel: Model<ConversationKeyDocument>
  let service: E2eeKeysService

  const CONVERSATION_WITH_KEY = 'conv-e2ee-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const CONVERSATION_WITHOUT_KEY = 'conv-e2ee-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  beforeAll(async () => {
    mongoConnection = (await connect(TEST_MONGO_URI)).connection
    keyModel = mongoConnection.model<ConversationKeyDocument>(
      ConversationKey.name,
      ConversationKeySchema,
    )
    service = new E2eeKeysService(keyModel)
  })

  afterEach(async () => {
    await keyModel.deleteMany({})
  })

  afterAll(async () => {
    await mongoConnection.dropDatabase()
    await mongoConnection.close()
  })

  it('returns null, and creates no document, for a conversation with no key on file', async () => {
    const result = await service.getExistingKey(CONVERSATION_WITHOUT_KEY)

    expect(result).toBeNull()
    expect(await keyModel.countDocuments({})).toBe(0)
  })

  it('returns the existing key unchanged for a conversation that already has one (legacy decrypt)', async () => {
    await new keyModel({
      conversationId: CONVERSATION_WITH_KEY,
      key: 'pre-existing-base64-key==',
      version: 'v-legacy-1',
    }).save()

    const result = await service.getExistingKey(CONVERSATION_WITH_KEY)

    expect(result).toEqual({ key: 'pre-existing-base64-key==', version: 'v-legacy-1' })
    expect(await keyModel.countDocuments({})).toBe(1)
  })

  it('never mutates an existing key record just by being read', async () => {
    await new keyModel({
      conversationId: CONVERSATION_WITH_KEY,
      key: 'stable-key',
      version: 'v1',
    }).save()

    await service.getExistingKey(CONVERSATION_WITH_KEY)
    await service.getExistingKey(CONVERSATION_WITH_KEY)
    const stored = await keyModel.findOne({ conversationId: CONVERSATION_WITH_KEY }).lean()

    expect(stored?.key).toBe('stable-key')
    expect(stored?.version).toBe('v1')
  })
})
