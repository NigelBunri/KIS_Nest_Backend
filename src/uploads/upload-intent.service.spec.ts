import { BadRequestException } from '@nestjs/common'
import { UploadIntentService } from './upload-intent.service'
import { MAX_UPLOAD_BYTES } from './upload-validation'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function makeIntentModel() {
  const created: any[] = []
  const create = jest.fn(async (doc: any) => {
    created.push(doc)
    return doc
  })
  const findOne = jest.fn()
  return { create, findOne, created } as any
}

function makeStorage(overrides: Partial<Record<string, any>> = {}) {
  return {
    isPublic: () => false,
    generatePresignedPut: jest.fn().mockResolvedValue('https://s3.example.com/put?sig=abc'),
    headObjectMeta: jest.fn().mockResolvedValue({ size: 17711064, contentType: 'video/mp4' }),
    publicUrlFor: (key: string) => `https://cdn.example.com/${key}`,
    ...overrides,
  } as any
}

function makeConfirmableIntent(overrides: Partial<Record<string, any>> = {}) {
  return {
    uploadId: 'a1a1a1a1-1111-1111-1111-111111111111',
    objectKey: '2026-08-02/1a55cbad-dd03-4f67-be7a-fa041dfec3da-video.mp4',
    ownerId: 'user-1',
    contentType: 'video/mp4',
    originalFilename: 'video.mp4',
    sizeBytes: 17711064,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('UploadIntentService.initiate', () => {
  it('returns an explicit uploadId that is distinct from, and never contains, the storage key', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage())

    const result = await service.initiate({
      userId: 'user-1',
      filename: 'video.mp4',
      contentType: 'video/mp4',
      sizeBytes: 17711064,
    })

    expect(UUID_RE.test(result.uploadId)).toBe(true)
    expect(result.storageKey).toContain('/')
    expect(result.storageKey).not.toBe(result.uploadId)
    expect(result.uploadId).not.toContain('/')
    // Legacy snake_case aliases must point at the same, correct values —
    // never at the storage key.
    expect(result.upload_id).toBe(result.uploadId)
    expect(result.object_key).toBe(result.storageKey)
  })

  it('never derives the storage key from client input (server-controlled, unique per call)', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage())

    const first = await service.initiate({ userId: 'user-1', filename: 'video.mp4', contentType: 'video/mp4', sizeBytes: 100 })
    const second = await service.initiate({ userId: 'user-1', filename: 'video.mp4', contentType: 'video/mp4', sizeBytes: 100 })

    expect(first.storageKey).not.toBe(second.storageKey)
    expect(first.uploadId).not.toBe(second.uploadId)
  })

  it('accepts a video/mp4 under the configured size limit (17.7MB test file)', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage())

    await expect(
      service.initiate({ userId: 'user-1', filename: 'video.mp4', contentType: 'video/mp4', sizeBytes: 17711064 }),
    ).resolves.toMatchObject({ uploadId: expect.any(String) })
  })

  it('rejects an oversized upload with the project standard 400 error', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage())

    await expect(
      service.initiate({
        userId: 'user-1',
        filename: 'huge.mp4',
        contentType: 'video/mp4',
        sizeBytes: MAX_UPLOAD_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects an unsupported MIME type with the project standard 400 error', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage())

    await expect(
      service.initiate({ userId: 'user-1', filename: 'file.bin', contentType: 'application/x-bogus', sizeBytes: 100 }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('UploadIntentService.confirm', () => {
  it('succeeds when given the uploadId returned by initiate', async () => {
    const intent = makeConfirmableIntent()
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const service = new UploadIntentService(intentModel, makeStorage())

    const attachment: any = await service.confirm({ userId: 'user-1', uploadId: intent.uploadId })

    expect(intentModel.findOne).toHaveBeenCalledWith({ uploadId: intent.uploadId, ownerId: 'user-1' })
    expect(attachment.id).toBeDefined()
    expect(UUID_RE.test(attachment.id)).toBe(true)
  })

  it('mints a stable attachmentId distinct from the storage key', async () => {
    const intent = makeConfirmableIntent()
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const service = new UploadIntentService(intentModel, makeStorage())

    const attachment: any = await service.confirm({ userId: 'user-1', uploadId: intent.uploadId })

    expect(attachment.id).not.toBe(intent.objectKey)
    expect(attachment.storageKey).toBe(intent.objectKey)
    expect(intent.attachmentId).toBe(attachment.id)
  })

  it('rejects a storage key sent as the confirm id with a controlled 400, not a DB lookup', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage())

    await expect(
      service.confirm({
        userId: 'user-1',
        uploadId: '2026-08-02/1a55cbad-dd03-4f67-be7a-fa041dfec3da-video.mp4',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    // The format guard must reject before ever touching the database.
    expect(intentModel.findOne).not.toHaveBeenCalled()
  })

  it('rejects a missing/empty uploadId', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage())

    await expect(service.confirm({ userId: 'user-1', uploadId: '' as any })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('returns 404-equivalent NotFoundException for an unknown (but well-formed) uploadId', async () => {
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(null)
    const service = new UploadIntentService(intentModel, makeStorage())

    await expect(
      service.confirm({ userId: 'user-1', uploadId: 'b2b2b2b2-2222-2222-2222-222222222222' }),
    ).rejects.toMatchObject({ status: 404 })
  })
})
