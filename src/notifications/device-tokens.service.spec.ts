import { DeviceTokensService } from './device-tokens.service'

function buildModel() {
  const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 })
  const updateOne = jest.fn().mockResolvedValue({})
  const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 })
  const select = jest.fn().mockResolvedValue([])
  const find = jest.fn(() => ({ select }))
  return { deleteMany, updateOne, updateMany, find, select }
}

describe('DeviceTokensService.upsert', () => {
  it('reassigns a token from a previous owner before upserting for the new one', async () => {
    const model = buildModel()
    const service = new DeviceTokensService(model as any)

    await service.upsert({ userId: 'user-2', token: 'shared-token', platform: 'android' })

    // Deletes any OTHER user's row holding this exact token first — this is
    // what prevents the E11000 duplicate-key crash on the unique `token`
    // index when a second account logs into the same device install
    // without FCM ever rotating the token.
    expect(model.deleteMany).toHaveBeenCalledWith({ token: 'shared-token', userId: { $ne: 'user-2' } })
    // Both calls' relative order matters (delete must happen before the
    // upsert can safely run) — the implementation awaits them
    // sequentially, so asserting the deleteMany call's own invocation
    // order is earlier than updateOne's confirms that without needing a
    // non-core matcher.
    expect(model.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      model.updateOne.mock.invocationCallOrder[0],
    )
    expect(model.updateOne).toHaveBeenCalledWith(
      { userId: 'user-2', token: 'shared-token' },
      expect.objectContaining({ $set: expect.objectContaining({ active: true }) }),
      { upsert: true },
    )
  })

  it('defaults tokenType to fcm and preserves an explicit voip type', async () => {
    const model = buildModel()
    const service = new DeviceTokensService(model as any)

    await service.upsert({ userId: 'user-1', token: 't1', platform: 'ios' })
    expect(model.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ tokenType: 'fcm' }) }),
      expect.anything(),
    )

    await service.upsert({ userId: 'user-1', token: 't2', platform: 'ios', tokenType: 'voip' })
    expect(model.updateOne).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ tokenType: 'voip' }) }),
      expect.anything(),
    )
  })
})

describe('DeviceTokensService.deactivate / deactivateForDevice', () => {
  it('deactivates by exact (userId, token)', async () => {
    const model = buildModel()
    const service = new DeviceTokensService(model as any)

    await service.deactivate({ userId: 'user-1', token: 't1' })
    expect(model.updateOne).toHaveBeenCalledWith(
      { userId: 'user-1', token: 't1' },
      { $set: { active: false } },
    )
  })

  it('deactivates every token registered for a device install', async () => {
    const model = buildModel()
    model.updateMany.mockResolvedValueOnce({ modifiedCount: 2 })
    const service = new DeviceTokensService(model as any)

    const result = await service.deactivateForDevice({ userId: 'user-1', deviceId: 'device-1' })
    expect(model.updateMany).toHaveBeenCalledWith(
      { userId: 'user-1', deviceId: 'device-1' },
      { $set: { active: false } },
    )
    expect(result).toEqual({ ok: true, deactivated: 2 })
  })
})

describe('DeviceTokensService.listActiveTokens / listActiveVoipTokens', () => {
  it('excludes voip tokens from the regular FCM list', async () => {
    const model = buildModel()
    const service = new DeviceTokensService(model as any)
    await service.listActiveTokens('user-1')
    expect(model.find).toHaveBeenCalledWith({ userId: 'user-1', active: true, tokenType: { $ne: 'voip' } })
  })

  it('only returns ios voip tokens for the voip list', async () => {
    const model = buildModel()
    const service = new DeviceTokensService(model as any)
    await service.listActiveVoipTokens('user-1')
    expect(model.find).toHaveBeenCalledWith({ userId: 'user-1', active: true, tokenType: 'voip', platform: 'ios' })
  })
})
