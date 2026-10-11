import { NotificationsService } from './notifications.service'

// createFcmProvider()/createApnsVoipProvider() both fall back to null in a
// test environment with no FCM_SERVICE_ACCOUNT_*/APNS_* env vars set, so a
// plain `new NotificationsService(...)` here exercises the real
// "unconfigured" path — the same one production would hit if it forgot to
// set the real credentials, which is exactly the scenario Part N/health
// status exists to make visible instead of silently dropping every push.
describe('NotificationsService.getProviderStatus', () => {
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
  })

  it('reports dummy/unconfigured when no FCM or APNs credentials are set', () => {
    const tokens = {} as any
    const prefs = {} as any
    const service = new NotificationsService(tokens, prefs)

    expect(service.getProviderStatus()).toEqual({
      fcm_configured: false,
      apns_voip_configured: false,
      active_push_provider: 'dummy',
    })
  })
})

// Regression coverage for "push notifications show user IDs instead of
// names": notifyIncomingCall/notifyMissedCall must never fall back to the
// raw fromUserId in any push-facing text (title/body/callerName), only to
// a phone number, then a neutral label.
describe('NotificationsService — caller identity fallback (never show a raw id)', () => {
  const makeService = () => {
    const tokens = {
      listActiveTokens: jest.fn().mockResolvedValue(['tok-1']),
      listActiveVoipTokens: jest.fn().mockResolvedValue([]),
      bulkDeactivate: jest.fn().mockResolvedValue(0),
    }
    const userPrefsClient = { getNotificationPrefs: jest.fn().mockResolvedValue(null) }
    const service = new NotificationsService(tokens as any, userPrefsClient as any)
    const send = jest.fn().mockResolvedValue({ delivered: 1, failedTokens: [], transientTokens: [] })
    ;(service as any).provider = { send }
    return { service, send }
  }

  it('uses fromDisplayName when present', async () => {
    const { service, send } = makeService()
    await service.notifyMissedCall({
      toUserId: 'u1', fromUserId: 'raw-id-123', fromDisplayName: 'Ada Lovelace',
      conversationId: 'c1', callId: 'call-1',
    })
    const [, msg] = send.mock.calls[0]
    expect(msg.body).toContain('Ada Lovelace')
    expect(msg.body).not.toContain('raw-id-123')
  })

  it('falls back to fromPhone when there is no display name', async () => {
    const { service, send } = makeService()
    await service.notifyMissedCall({
      toUserId: 'u1', fromUserId: 'raw-id-123', fromPhone: '+15551234567',
      conversationId: 'c1', callId: 'call-1',
    })
    const [, msg] = send.mock.calls[0]
    expect(msg.body).toContain('+15551234567')
    expect(msg.body).not.toContain('raw-id-123')
  })

  it('falls back to the neutral "KIS user" label — never the raw id — when neither is available', async () => {
    const { service, send } = makeService()
    await service.notifyMissedCall({
      toUserId: 'u1', fromUserId: 'raw-id-123',
      conversationId: 'c1', callId: 'call-1',
    })
    const [, msg] = send.mock.calls[0]
    expect(msg.body).toContain('KIS user')
    expect(msg.body).not.toContain('raw-id-123')
  })

  it('same fallback chain applies to notifyIncomingCall, including the data-only FCM payload callerName field', async () => {
    const { service, send } = makeService()
    await service.notifyIncomingCall({
      toUserId: 'u1', fromUserId: 'raw-id-123',
      conversationId: 'c1', callId: 'call-1',
    })
    const [, msg] = send.mock.calls[0]
    expect(msg.body).not.toContain('raw-id-123')
    expect(msg.data.callerName).toBe('KIS user')
  })

  it('tags incoming-call pushes with a short expiry and a sentAt timestamp (stale-ring protection)', async () => {
    const { service, send } = makeService()
    const before = Date.now()
    await service.notifyIncomingCall({
      toUserId: 'u1', fromUserId: 'u2', conversationId: 'c1', callId: 'call-1',
    })
    const [, msg] = send.mock.calls[0]
    expect(msg.expiresInSeconds).toBe(60)
    expect(Number(msg.data.sentAt)).toBeGreaterThanOrEqual(before)
  })
})
