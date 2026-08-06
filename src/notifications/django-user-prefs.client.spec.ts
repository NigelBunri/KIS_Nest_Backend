import { of, throwError } from 'rxjs'
import { DjangoUserPrefsClient } from './django-user-prefs.client'

function buildHttp(impl: () => any) {
  return { get: jest.fn(impl) } as any
}

describe('DjangoUserPrefsClient.getNotificationPrefs', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV, DJANGO_API_URL: 'https://django.internal/api/v1', DJANGO_INTERNAL_TOKEN: 'secret' }
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('calls the trusted-internal endpoint, not /profile-preferences/me/', async () => {
    const http = buildHttp(() => of({ data: { notification_preferences: { notif_calls: false } } }))
    const client = new DjangoUserPrefsClient(http)

    const prefs = await client.getNotificationPrefs('user-1')

    expect(prefs).toEqual({ notif_calls: false })
    const [url, config] = http.get.mock.calls[0]
    // The old route (/api/v1/profile-preferences/me/) requires a real
    // per-user JWT this client never sends — every call there always
    // 401ed, silently making every DND/mute check a no-op. This is the
    // regression test for that fix.
    expect(url).toBe('https://django.internal/api/v1/profile-preferences/internal/notification-prefs/')
    expect(url).not.toContain('/me/')
    expect(config.params).toEqual({ user_id: 'user-1' })
    expect(config.headers['X-Internal-User-Id']).toBe('user-1')
    // Real HMAC internal-auth headers must be present (see internal-signing.ts).
    expect(config.headers['X-Internal-Auth']).toBe('secret')
    expect(config.headers['X-Internal-Signature']).toEqual(expect.any(String))
  })

  it('returns null and does not throw when Django is unreachable (documented fail-open)', async () => {
    const http = buildHttp(() => throwError(() => new Error('ECONNREFUSED')))
    const client = new DjangoUserPrefsClient(http)

    const prefs = await client.getNotificationPrefs('user-1')
    expect(prefs).toBeNull()
  })

  it('caches a result for repeated calls within the TTL window (no duplicate request)', async () => {
    const http = buildHttp(() => of({ data: { notification_preferences: { notif_messages: true } } }))
    const client = new DjangoUserPrefsClient(http)

    await client.getNotificationPrefs('user-1')
    await client.getNotificationPrefs('user-1')

    expect(http.get).toHaveBeenCalledTimes(1)
  })

  it('returns null without making a network call when Django is not configured', async () => {
    process.env.DJANGO_API_URL = ''
    process.env.API_BASE_URL = ''
    const http = buildHttp(() => of({ data: {} }))
    const client = new DjangoUserPrefsClient(http)

    const prefs = await client.getNotificationPrefs('user-1')
    expect(prefs).toBeNull()
    expect(http.get).not.toHaveBeenCalled()
  })
})
