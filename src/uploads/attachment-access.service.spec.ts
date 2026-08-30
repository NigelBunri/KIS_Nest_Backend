import { ForbiddenException, GoneException, NotFoundException } from '@nestjs/common'
import { AttachmentAccessService } from './attachment-access.service'

function makeMessageModel(message: any) {
  const exec = jest.fn().mockResolvedValue(message)
  const lean = jest.fn(() => ({ exec }))
  const findOne = jest.fn(() => ({ lean }))
  return { findOne } as any
}

function makeStorage(overrides: Partial<Record<string, any>> = {}) {
  return {
    driver: () => 's3',
    isPublic: () => false,
    headObjectMeta: jest.fn().mockResolvedValue({ size: 1234, contentType: 'image/jpeg' }),
    generatePresignedGet: jest.fn().mockResolvedValue('https://s3.example.com/signed?sig=abc'),
    getFile: jest.fn(),
    ...overrides,
  } as any
}

function makeDjango(overrides: Partial<Record<string, any>> = {}) {
  return {
    assertMember: jest.fn().mockResolvedValue({ isMember: true, isBlocked: false }),
    ...overrides,
  } as any
}

const baseAttachment = {
  id: 'att-uuid-1',
  storageKey: '2026-01-01/uuid-photo.jpg',
  originalName: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 1234,
}

const baseMessage = {
  _id: 'msg-1',
  conversationId: 'conv-1',
  isDeleted: false,
  attachments: [baseAttachment],
}

const principal = { userId: 'user-1', token: 'tok' }

describe('AttachmentAccessService.resolveForDownloadUrl', () => {
  it('returns a fresh presigned URL for a participant', async () => {
    const storage = makeStorage()
    const django = makeDjango()
    const service = new AttachmentAccessService(makeMessageModel(baseMessage), storage, django)

    const result = await service.resolveForDownloadUrl('att-uuid-1', principal)

    expect(django.assertMember).toHaveBeenCalledWith(principal, 'conv-1')
    expect(storage.generatePresignedGet).toHaveBeenCalledWith('2026-01-01/uuid-photo.jpg', expect.any(Number), 'photo.jpg')
    expect(result.downloadUrl).toBe('https://s3.example.com/signed?sig=abc')
    expect(result.originalName).toBe('photo.jpg')
    expect(result.attachmentId).toBe('att-uuid-1')
  })

  it('rejects a non-participant with 403', async () => {
    const storage = makeStorage()
    const django = makeDjango({ assertMember: jest.fn().mockRejectedValue(new Error('not a member')) })
    const service = new AttachmentAccessService(makeMessageModel(baseMessage), storage, django)

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('returns 404 for an unknown attachment id', async () => {
    const service = new AttachmentAccessService(makeMessageModel(null), makeStorage(), makeDjango())

    await expect(service.resolveForDownloadUrl('does-not-exist', principal)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('returns 404 when the owning message was deleted', async () => {
    const service = new AttachmentAccessService(
      makeMessageModel({ ...baseMessage, isDeleted: true }),
      makeStorage(),
      makeDjango(),
    )

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('returns 410 for an expired attachment', async () => {
    const message = {
      ...baseMessage,
      attachments: [{ ...baseAttachment, expired: true }],
    }
    const service = new AttachmentAccessService(makeMessageModel(message), makeStorage(), makeDjango())

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(GoneException)
  })

  it('returns 410 for an attachment past its expiresAt even if not yet flagged expired', async () => {
    const message = {
      ...baseMessage,
      attachments: [{ ...baseAttachment, expired: false, expiresAt: new Date(Date.now() - 1000).toISOString() }],
    }
    const service = new AttachmentAccessService(makeMessageModel(message), makeStorage(), makeDjango())

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(GoneException)
  })

  it('returns 410 for an already-viewed view-once attachment', async () => {
    const message = {
      ...baseMessage,
      attachments: [{ ...baseAttachment, viewOnce: true, viewedAt: new Date().toISOString() }],
    }
    const service = new AttachmentAccessService(makeMessageModel(message), makeStorage(), makeDjango())

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(GoneException)
  })

  it('rejects a quarantined attachment', async () => {
    const message = {
      ...baseMessage,
      attachments: [{ ...baseAttachment, quarantined: true }],
    }
    const service = new AttachmentAccessService(makeMessageModel(message), makeStorage(), makeDjango())

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('rejects an attachment still pending safety review', async () => {
    const message = {
      ...baseMessage,
      attachments: [{ ...baseAttachment, scanStatus: 'pending_review' }],
    }
    const service = new AttachmentAccessService(makeMessageModel(message), makeStorage(), makeDjango())

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('returns 404 when the object is missing from storage', async () => {
    const storage = makeStorage({ headObjectMeta: jest.fn().mockResolvedValue(null) })
    const service = new AttachmentAccessService(makeMessageModel(baseMessage), storage, makeDjango())

    await expect(service.resolveForDownloadUrl('att-uuid-1', principal)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('falls back to id as the storage key for legacy attachments with no storageKey', async () => {
    const legacyAttachment = {
      id: '2026-01-01/legacy-key.jpg',
      originalName: 'legacy.jpg',
      mimeType: 'image/jpeg',
      size: 999,
    }
    const message = { ...baseMessage, attachments: [legacyAttachment] }
    const storage = makeStorage()
    const service = new AttachmentAccessService(makeMessageModel(message), storage, makeDjango())

    await service.resolveForDownloadUrl('2026-01-01/legacy-key.jpg', principal)

    expect(storage.headObjectMeta).toHaveBeenCalledWith('2026-01-01/legacy-key.jpg')
    expect(storage.generatePresignedGet).toHaveBeenCalledWith('2026-01-01/legacy-key.jpg', expect.any(Number), 'legacy.jpg')
  })

  it('resolves a filename containing spaces and special characters', async () => {
    const message = {
      ...baseMessage,
      attachments: [{ ...baseAttachment, originalName: 'My Résumé (final) #2.pdf' }],
    }
    const storage = makeStorage()
    const service = new AttachmentAccessService(makeMessageModel(message), storage, makeDjango())

    const result = await service.resolveForDownloadUrl('att-uuid-1', principal)

    expect(result.originalName).toBe('My Résumé (final) #2.pdf')
    expect(storage.generatePresignedGet).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 'My Résumé (final) #2.pdf')
  })

  it('returns an authenticated stream path (not a raw key) for local storage', async () => {
    const storage = makeStorage({ driver: () => 'local' })
    const service = new AttachmentAccessService(makeMessageModel(baseMessage), storage, makeDjango())

    const result = await service.resolveForDownloadUrl('att-uuid-1', principal, 'https://api.example.com')

    expect(result.downloadUrl).toBe('https://api.example.com/uploads/att-uuid-1/stream')
    expect(storage.generatePresignedGet).not.toHaveBeenCalled()
  })
})

describe('AttachmentAccessService.resolveForLegacyKeyDownload', () => {
  it('resolves by storageKey and applies the same authorization checks', async () => {
    const service = new AttachmentAccessService(makeMessageModel(baseMessage), makeStorage(), makeDjango())

    const result = await service.resolveForLegacyKeyDownload('2026-01-01/uuid-photo.jpg', principal)

    expect(result.storageKey).toBe('2026-01-01/uuid-photo.jpg')
  })

  it('returns 404 for a key with no owning message (never trusts a bare key)', async () => {
    const service = new AttachmentAccessService(makeMessageModel(null), makeStorage(), makeDjango())

    await expect(service.resolveForLegacyKeyDownload('unknown-key.jpg', principal)).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('AttachmentAccessService.quarantineByStorageKey', () => {
  function makeUpdatableModel(modifiedCounts: number[]) {
    const updateOne = jest.fn()
    modifiedCounts.forEach((count) => updateOne.mockResolvedValueOnce({ modifiedCount: count }))
    return { updateOne } as any
  }

  it('flips quarantined/scanStatus on the matching attachment by storageKey', async () => {
    const model = makeUpdatableModel([1])
    const service = new AttachmentAccessService(model, makeStorage(), makeDjango())

    const found = await service.quarantineByStorageKey('2026-01-01/uuid-photo.jpg')

    expect(found).toBe(true)
    expect(model.updateOne).toHaveBeenCalledWith(
      { 'attachments.storageKey': '2026-01-01/uuid-photo.jpg' },
      { $set: { 'attachments.$.quarantined': true, 'attachments.$.scanStatus': 'blocked' } },
    )
  })

  it('falls back to matching by attachments.id for legacy rows with no storageKey', async () => {
    const model = makeUpdatableModel([0, 1])
    const service = new AttachmentAccessService(model, makeStorage(), makeDjango())

    const found = await service.quarantineByStorageKey('legacy-key-as-id')

    expect(found).toBe(true)
    expect(model.updateOne).toHaveBeenNthCalledWith(
      2,
      { 'attachments.id': 'legacy-key-as-id' },
      { $set: { 'attachments.$.quarantined': true, 'attachments.$.scanStatus': 'blocked' } },
    )
  })

  it('returns false when no message has a matching attachment (never throws)', async () => {
    const model = makeUpdatableModel([0, 0])
    const service = new AttachmentAccessService(model, makeStorage(), makeDjango())

    await expect(service.quarantineByStorageKey('unknown-key')).resolves.toBe(false)
  })

  it('returns false for an empty objectKey without touching the database', async () => {
    const model = makeUpdatableModel([])
    const service = new AttachmentAccessService(model, makeStorage(), makeDjango())

    await expect(service.quarantineByStorageKey('')).resolves.toBe(false)
    expect(model.updateOne).not.toHaveBeenCalled()
  })
})
