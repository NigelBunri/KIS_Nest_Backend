// Defect D2 companion coverage: the GET key endpoint must 404 instead of
// fabricating a key when E2eeKeysService has none on file for this
// conversation (see e2ee-keys.service.spec.ts for the service-level proof
// that no key is ever created).

import { NotFoundException } from '@nestjs/common'
import { E2eeController } from './e2ee.controller'

describe('E2eeController.getKey', () => {
  const principal = { userId: 'user-1' }

  function makeController(entry: { key: string; version: string } | null) {
    const e2eeKeysService = { getExistingKey: jest.fn().mockResolvedValue(entry) } as any
    const djangoConversationClient = { assertMember: jest.fn().mockResolvedValue(undefined) } as any
    const controller = new E2eeController(e2eeKeysService, djangoConversationClient)
    return { controller, e2eeKeysService, djangoConversationClient }
  }

  it('returns the key when one exists on file', async () => {
    const { controller } = makeController({ key: 'k', version: 'v1' })

    const result = await controller.getKey('conv-1', { principal } as any)

    expect(result).toEqual({ key: 'k', version: 'v1', encryptionVersion: 'custom-aes-2' })
  })

  it('404s instead of fabricating a key when none exists', async () => {
    const { controller } = makeController(null)

    await expect(controller.getKey('conv-1', { principal } as any)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('checks membership before returning a key', async () => {
    const { controller, djangoConversationClient } = makeController({ key: 'k', version: 'v1' })

    await controller.getKey('conv-1', { principal } as any)

    expect(djangoConversationClient.assertMember).toHaveBeenCalledWith(principal, 'conv-1')
  })
})
