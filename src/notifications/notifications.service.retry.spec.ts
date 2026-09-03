import { NotificationsService } from './notifications.service'

// Coverage for the bounded transient-failure retry added to notify(). No DI
// seam exists for the push provider (createFcmProvider() is called inside
// the constructor), so these tests override the private `provider` field
// directly after construction — the same acceptable pattern as reaching
// into any other untestable-by-design internal for a unit test.
describe('NotificationsService — bounded push retry', () => {
  const OLD_ENV = process.env
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.FCM_SERVICE_ACCOUNT_JSON
    delete process.env.FCM_SERVICE_ACCOUNT_PATH
    delete process.env.APNS_KEY_BASE64
    delete process.env.APNS_KEY_PATH
  })
  afterEach(() => {
    process.env = OLD_ENV
    jest.restoreAllMocks()
  })

  const makeService = (tokensOverrides: Record<string, any> = {}) => {
    const tokens = {
      listActiveTokens: jest.fn().mockResolvedValue(['tok-1']),
      listActiveVoipTokens: jest.fn().mockResolvedValue([]),
      bulkDeactivate: jest.fn().mockResolvedValue(0),
      ...tokensOverrides,
    }
    const userPrefsClient = { getNotificationPrefs: jest.fn().mockResolvedValue(null) }
    const service = new NotificationsService(tokens as any, userPrefsClient as any)
    return { service, tokens, userPrefsClient }
  }

  it('does NOT retry by default (opts omitted) even on total transient failure', async () => {
    const { service } = makeService()
    const send = jest.fn().mockResolvedValue({ delivered: 0, failedTokens: [], transientTokens: ['tok-1'] })
    ;(service as any).provider = { send }

    const result = await service.notify({ userId: 'u1' }, { title: 't', body: 'b' })

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.delivered).toBe(0)
  })

  it('retries ONCE on total transient failure when retryOnTransientFailure is set, and sums delivered counts', async () => {
    const { service } = makeService()
    const send = jest.fn()
      .mockResolvedValueOnce({ delivered: 0, failedTokens: [], transientTokens: ['tok-1'] })
      .mockResolvedValueOnce({ delivered: 1, failedTokens: [], transientTokens: [] })
    ;(service as any).provider = { send }

    const result = await service.notify(
      { userId: 'u1' },
      { title: 't', body: 'b' },
      { retryOnTransientFailure: true },
    )

    expect(send).toHaveBeenCalledTimes(2)
    // Second call retries only the tokens that failed transiently the first time.
    expect(send).toHaveBeenNthCalledWith(2, ['tok-1'], expect.anything())
    expect(result.delivered).toBe(1)
  })

  it('does not retry a second time even if the retry attempt also fails (bounded, no storm)', async () => {
    const { service } = makeService()
    const send = jest.fn()
      .mockResolvedValueOnce({ delivered: 0, failedTokens: [], transientTokens: ['tok-1'] })
      .mockResolvedValueOnce({ delivered: 0, failedTokens: [], transientTokens: ['tok-1'] })
    ;(service as any).provider = { send }

    const result = await service.notify(
      { userId: 'u1' },
      { title: 't', body: 'b' },
      { retryOnTransientFailure: true },
    )

    expect(send).toHaveBeenCalledTimes(2)
    expect(result.delivered).toBe(0)
  })

  it('does not retry when at least one token was delivered on the first attempt', async () => {
    const { service, tokens } = makeService({ listActiveTokens: jest.fn().mockResolvedValue(['tok-1', 'tok-2']) })
    const send = jest.fn().mockResolvedValue({ delivered: 1, failedTokens: [], transientTokens: ['tok-2'] })
    ;(service as any).provider = { send }

    await service.notify({ userId: 'u1' }, { title: 't', body: 'b' }, { retryOnTransientFailure: true })

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('deactivates permanently-invalid tokens without retrying them', async () => {
    const { service, tokens } = makeService()
    const send = jest.fn().mockResolvedValue({ delivered: 0, failedTokens: ['tok-1'], transientTokens: [] })
    ;(service as any).provider = { send }

    await service.notify({ userId: 'u1' }, { title: 't', body: 'b' }, { retryOnTransientFailure: true })

    expect(tokens.bulkDeactivate).toHaveBeenCalledWith(['tok-1'])
    // Nothing transient to retry — a single send call is correct.
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('notifyIncomingCall opts into the bounded retry (highest-stakes push type)', async () => {
    const { service } = makeService()
    const send = jest.fn()
      .mockResolvedValueOnce({ delivered: 0, failedTokens: [], transientTokens: ['tok-1'] })
      .mockResolvedValueOnce({ delivered: 1, failedTokens: [], transientTokens: [] })
    ;(service as any).provider = { send }

    const result = await service.notifyIncomingCall({
      toUserId: 'u1',
      fromUserId: 'u2',
      conversationId: 'conv-1',
      callId: 'call-1',
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect((result as any).delivered).toBe(1)
  })
})
