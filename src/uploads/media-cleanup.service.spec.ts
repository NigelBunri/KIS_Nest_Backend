import { MediaCleanupService } from './media-cleanup.service'

function makeQuery(rows: any[]) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(rows),
  }
}

function legacyIntentMissingUploadId(overrides: Partial<Record<string, any>> = {}) {
  // Simulates a document persisted before `uploadId` became a required
  // schema field (added in commit 59aadd5) — no backfill ever ran for rows
  // that predate that change, so `uploadId` is genuinely absent on read.
  const err = new Error("UploadIntent validation failed: uploadId: Path `uploadId` is required.")
  return {
    _id: 'legacy-id-1',
    objectKey: 'legacy/no-upload-id-key',
    status: 'pending',
    save: jest.fn().mockRejectedValue(err),
    ...overrides,
  }
}

function modernIntent(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: 'modern-id-1',
    objectKey: '2026-08-05/abc-file.jpg',
    uploadId: 'a1a1a1a1-1111-1111-1111-111111111111',
    status: 'pending',
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('MediaCleanupService.runAbandonedIntentCleanup', () => {
  it('force-expires a legacy record missing uploadId via a direct update instead of throwing', async () => {
    const legacy = legacyIntentMissingUploadId()
    const find = jest.fn().mockReturnValue(makeQuery([legacy]))
    const updateOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) })
    const uploadIntentModel = { find, updateOne } as any
    const storage = { deleteFile: jest.fn().mockResolvedValue(undefined) } as any
    const service = new MediaCleanupService({} as any, uploadIntentModel, storage)

    await expect(service.runAbandonedIntentCleanup()).resolves.toBeUndefined()

    expect(legacy.save).toHaveBeenCalledTimes(1)
    expect(updateOne).toHaveBeenCalledWith({ _id: 'legacy-id-1' }, { $set: { status: 'expired' } })
  })

  it('does not abort the batch — a legacy record failing to save must not block later candidates from being processed', async () => {
    // Regression test: this is the actual production defect. The original
    // code called `await intent.save()` with no try/catch, so a validation
    // failure on the first candidate (legacy/oldest records sort first via
    // `.sort({ expiresAt: 1 })`) threw out of the `for` loop and left every
    // other candidate in the batch — including genuinely abandoned, healthy
    // intents that should have been cleaned up — untouched.
    const legacy = legacyIntentMissingUploadId()
    const healthy = modernIntent()
    const find = jest.fn().mockReturnValue(makeQuery([legacy, healthy]))
    const updateOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) })
    const uploadIntentModel = { find, updateOne } as any
    const storage = { deleteFile: jest.fn().mockResolvedValue(undefined) } as any
    const service = new MediaCleanupService({} as any, uploadIntentModel, storage)

    await service.runAbandonedIntentCleanup()

    expect(healthy.save).toHaveBeenCalledTimes(1)
    expect(healthy.status).toBe('expired')
  })

  it('still expires a normal record via document.save() (happy path unchanged)', async () => {
    const healthy = modernIntent()
    const find = jest.fn().mockReturnValue(makeQuery([healthy]))
    const uploadIntentModel = { find, updateOne: jest.fn() } as any
    const storage = { deleteFile: jest.fn().mockResolvedValue(undefined) } as any
    const service = new MediaCleanupService({} as any, uploadIntentModel, storage)

    await service.runAbandonedIntentCleanup()

    expect(healthy.save).toHaveBeenCalledTimes(1)
    expect(healthy.status).toBe('expired')
    expect(uploadIntentModel.updateOne).not.toHaveBeenCalled()
  })

  it('counts a cleanup failure without throwing if the direct-update fallback itself fails', async () => {
    const legacy = legacyIntentMissingUploadId()
    const find = jest.fn().mockReturnValue(makeQuery([legacy]))
    const updateOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockRejectedValue(new Error('mongo unavailable')),
    })
    const uploadIntentModel = { find, updateOne } as any
    const storage = { deleteFile: jest.fn().mockResolvedValue(undefined) } as any
    const service = new MediaCleanupService({} as any, uploadIntentModel, storage)

    await expect(service.runAbandonedIntentCleanup()).resolves.toBeUndefined()
  })

  it('still deletes the underlying storage object for a legacy record before force-expiring it', async () => {
    const legacy = legacyIntentMissingUploadId()
    const find = jest.fn().mockReturnValue(makeQuery([legacy]))
    const updateOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) })
    const uploadIntentModel = { find, updateOne } as any
    const storage = { deleteFile: jest.fn().mockResolvedValue(undefined) } as any
    const service = new MediaCleanupService({} as any, uploadIntentModel, storage)

    await service.runAbandonedIntentCleanup()

    expect(storage.deleteFile).toHaveBeenCalledWith('legacy/no-upload-id-key')
  })
})
