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
