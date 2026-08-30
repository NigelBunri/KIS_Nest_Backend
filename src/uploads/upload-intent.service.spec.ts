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

// Default: never called — every existing fixture has no `context`, so
// confirm()'s broadcast_video branch (the only caller of djangoMedia)
// never triggers for these pre-existing tests.
function makeDjangoMedia(overrides: Partial<Record<string, any>> = {}) {
  return {
    processVideoUpload: jest.fn(),
    notifyUploadForScan: jest.fn(),
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
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

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
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

    const first = await service.initiate({ userId: 'user-1', filename: 'video.mp4', contentType: 'video/mp4', sizeBytes: 100 })
    const second = await service.initiate({ userId: 'user-1', filename: 'video.mp4', contentType: 'video/mp4', sizeBytes: 100 })

    expect(first.storageKey).not.toBe(second.storageKey)
    expect(first.uploadId).not.toBe(second.uploadId)
  })

  it('accepts a video/mp4 under the configured size limit (17.7MB test file)', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

    await expect(
      service.initiate({ userId: 'user-1', filename: 'video.mp4', contentType: 'video/mp4', sizeBytes: 17711064 }),
    ).resolves.toMatchObject({ uploadId: expect.any(String) })
  })

  it('rejects an oversized upload with the project standard 400 error', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

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
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

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
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

    const attachment: any = await service.confirm({ userId: 'user-1', uploadId: intent.uploadId })

    expect(intentModel.findOne).toHaveBeenCalledWith({ uploadId: intent.uploadId, ownerId: 'user-1' })
    expect(attachment.id).toBeDefined()
    expect(UUID_RE.test(attachment.id)).toBe(true)
  })

  it('mints a stable attachmentId distinct from the storage key', async () => {
    const intent = makeConfirmableIntent()
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

    const attachment: any = await service.confirm({ userId: 'user-1', uploadId: intent.uploadId })

    expect(attachment.id).not.toBe(intent.objectKey)
    expect(attachment.storageKey).toBe(intent.objectKey)
    expect(intent.attachmentId).toBe(attachment.id)
  })

  it('rejects a storage key sent as the confirm id with a controlled 400, not a DB lookup', async () => {
    const intentModel = makeIntentModel()
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

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
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

    await expect(service.confirm({ userId: 'user-1', uploadId: '' as any })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('returns 404-equivalent NotFoundException for an unknown (but well-formed) uploadId', async () => {
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(null)
    const service = new UploadIntentService(intentModel, makeStorage(), makeDjangoMedia())

    await expect(
      service.confirm({ userId: 'user-1', uploadId: 'b2b2b2b2-2222-2222-2222-222222222222' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('notifies Django to scan every confirmed upload for explicit content, regardless of context', async () => {
    const intent = makeConfirmableIntent({ context: 'chat' })
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const djangoMedia = makeDjangoMedia()
    const service = new UploadIntentService(intentModel, makeStorage(), djangoMedia)

    await service.confirm({ userId: 'user-1', uploadId: intent.uploadId })

    expect(djangoMedia.notifyUploadForScan).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: intent.objectKey,
        mimeType: 'video/mp4',
        context: 'chat',
        userId: 'user-1',
      }),
    )
  })

  it('does not let a scan-notification failure break the confirm response (fire-and-forget)', async () => {
    const intent = makeConfirmableIntent()
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const djangoMedia = makeDjangoMedia({
      notifyUploadForScan: jest.fn(() => {
        throw new Error('should never be awaited/propagated')
      }),
    })
    const service = new UploadIntentService(intentModel, makeStorage(), djangoMedia)

    await expect(service.confirm({ userId: 'user-1', uploadId: intent.uploadId })).resolves.toBeDefined()
  })
})

describe('UploadIntentService.confirm — broadcast_video post-confirm webhook', () => {
  it('calls Django processVideoUpload for a broadcast_video-context video and merges its result into the attachment', async () => {
    const intent = makeConfirmableIntent({ context: 'broadcast_video' })
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const djangoMedia = makeDjangoMedia({
      processVideoUpload: jest.fn().mockResolvedValue({
        video_id: 'video-123',
        video_url: 'https://cdn.example.com/video.mp4',
        thumbnail_url: 'https://cdn.example.com/thumb.jpg',
        duration_seconds: 42,
        type: 'short',
        scan_status: 'not_configured',
        quarantined: false,
        requires_review: false,
        safety_scan_id: 'scan-1',
        safety: { status: 'not_configured' },
        processing_status: 'ready',
        pipeline: {},
      }),
    })
    const service = new UploadIntentService(intentModel, makeStorage(), djangoMedia)

    const attachment: any = await service.confirm({
      userId: 'user-1',
      uploadId: intent.uploadId,
      title: 'My video',
      channelId: 'chan-1',
    })

    expect(djangoMedia.processVideoUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: intent.objectKey,
        mimeType: 'video/mp4',
        title: 'My video',
        channelId: 'chan-1',
        userId: 'user-1',
      }),
    )
    // Django's video id becomes the attachment's identity — downstream
    // consumers (mapServerVideoAttachment on the RN side) key off this.
    expect(attachment.id).toBe('video-123')
    expect(attachment.video_url).toBe('https://cdn.example.com/video.mp4')
    expect(attachment.duration_seconds).toBe(42)
  })

  it('resolves a thumbnailAttachmentId to its real objectKey before calling Django, never passing the client-facing id itself', async () => {
    const intent = makeConfirmableIntent({ context: 'broadcast_video' })
    const thumbIntent = { attachmentId: 'thumb-attachment-1', objectKey: '2026-08-02/thumb.jpg', status: 'confirmed' }
    const intentModel = makeIntentModel()
    // Two distinct lookups happen inside confirm(): the main intent (awaited
    // directly, no .lean()/.exec()) and the thumbnail intent (chained
    // through .lean().exec()) — mock each shape on its own call.
    intentModel.findOne = jest
      .fn()
      .mockReturnValueOnce(Promise.resolve(intent))
      .mockReturnValueOnce({ lean: () => ({ exec: () => Promise.resolve(thumbIntent) }) })
    const djangoMedia = makeDjangoMedia({
      processVideoUpload: jest.fn().mockResolvedValue({
        video_id: 'video-123',
        video_url: '',
        thumbnail_url: '',
        duration_seconds: 10,
        type: 'short',
        scan_status: 'not_configured',
        quarantined: false,
        requires_review: false,
        safety_scan_id: 'scan-1',
        safety: {},
        processing_status: 'ready',
        pipeline: {},
      }),
    })
    const service = new UploadIntentService(intentModel, makeStorage(), djangoMedia)

    await service.confirm({
      userId: 'user-1',
      uploadId: intent.uploadId,
      thumbnailAttachmentId: 'thumb-attachment-1',
    })

    expect(djangoMedia.processVideoUpload).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnailObjectKey: '2026-08-02/thumb.jpg' }),
    )
  })

  it('never marks the intent confirmed if the Django webhook fails — no orphaned attachment with no BroadcastVideo behind it', async () => {
    const intent = makeConfirmableIntent({ context: 'broadcast_video' })
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const djangoMedia = makeDjangoMedia({
      processVideoUpload: jest.fn().mockRejectedValue(new Error('Django unreachable')),
    })
    const service = new UploadIntentService(intentModel, makeStorage(), djangoMedia)

    await expect(
      service.confirm({ userId: 'user-1', uploadId: intent.uploadId }),
    ).rejects.toThrow('Django unreachable')

    expect(intent.status).not.toBe('confirmed')
    expect(intent.save).not.toHaveBeenCalled()
  })

  it('does not call Django for a non-broadcast_video context, even if the file happens to be a video', async () => {
    const intent = makeConfirmableIntent({ context: 'chat' })
    const intentModel = makeIntentModel()
    intentModel.findOne.mockResolvedValue(intent)
    const djangoMedia = makeDjangoMedia()
    const service = new UploadIntentService(intentModel, makeStorage(), djangoMedia)

    await service.confirm({ userId: 'user-1', uploadId: intent.uploadId })

    expect(djangoMedia.processVideoUpload).not.toHaveBeenCalled()
  })
})
