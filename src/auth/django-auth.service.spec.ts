import crypto from 'crypto'

process.env.DJANGO_JWT_SECRET = 'test-shared-secret-for-django-auth-spec'
process.env.DJANGO_JWT_STRICT = '0'
process.env.DJANGO_INTROSPECT_URL = 'https://django.internal.test/auth/introspect/'
process.env.DJANGO_INTERNAL_TOKEN = 'internal-test-token'
delete process.env.DJANGO_LOCAL_JWT_FIRST

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}))

import axios from 'axios'
import { UnauthorizedException } from '@nestjs/common'
import { DjangoAuthService } from './django-auth.service'

const mockedGet = axios.get as jest.Mock

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function makeToken(payload: Record<string, any>, secret = process.env.DJANGO_JWT_SECRET!): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signingInput = `${header}.${body}`
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

function validPayload(overrides: Record<string, any> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return { user_id: 'user-1', exp: now + 3600, iat: now, ...overrides }
}

describe('DjangoAuthService.introspect', () => {
  beforeEach(() => {
    mockedGet.mockReset()
    jest.useRealTimers()
  })

  it('rejects a malformed token without calling Django at all', async () => {
    const service = new DjangoAuthService()
    await expect(service.introspect('not-a-jwt')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('rejects an expired token locally without calling Django', async () => {
    const service = new DjangoAuthService()
    const expired = makeToken(validPayload({ exp: Math.floor(Date.now() / 1000) - 10 }))
    await expect(service.introspect(expired)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('rejects a token signed with the wrong secret without calling Django', async () => {
    const service = new DjangoAuthService()
    const bad = makeToken(validPayload(), 'wrong-secret')
    await expect(service.introspect(bad)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('a token that passes local validation still requires a successful Django round trip', async () => {
    const service = new DjangoAuthService()
    const token = makeToken(validPayload())
    mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1', tier: 'Free' } })

    const principal = await service.introspect(token)

    expect(mockedGet).toHaveBeenCalledTimes(1)
    expect(principal.userId).toBe('user-1')
  })

  it('forwards X-Device-Id when a deviceId is provided', async () => {
    const service = new DjangoAuthService()
    const token = makeToken(validPayload())
    mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1' } })

    await service.introspect(token, 'device-abc')

    const [, options] = mockedGet.mock.calls[0]
    expect(options.headers['X-Device-Id']).toBe('device-abc')
  })

  it('serves a cached principal within the TTL without calling Django again', async () => {
    const service = new DjangoAuthService()
    const token = makeToken(validPayload())
    mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1' } })

    await service.introspect(token)
    await service.introspect(token)

    expect(mockedGet).toHaveBeenCalledTimes(1)
  })

  it('an explicit 401 from Django is never masked by a stale cache hit — and poisons the cache entry', async () => {
    const service = new DjangoAuthService()
    // Force the positive cache to expire almost immediately so the next
    // introspect() call actually reaches Django instead of being served
    // from the (still valid at default TTL) cached principal — this is
    // what a device revocation happening after the cache was populated,
    // then the window elapsing, looks like.
    ;(service as any).positiveTtlMs = 1
    const token = makeToken(validPayload())
    mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1' } })
    await service.introspect(token) // populates cache
    await new Promise((r) => setTimeout(r, 5))

    mockedGet.mockRejectedValueOnce({ response: { status: 401, data: { detail: 'revoked' } } })
    await expect(service.introspect(token)).rejects.toBeInstanceOf(UnauthorizedException)

    // The rejection must also have cleared the cache entry — a THIRD call
    // (simulating Django being unreachable next) must not fall back to the
    // now-invalidated principal either.
    mockedGet.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(service.introspect(token)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('a network failure on a token with no prior successful validation is denied outright', async () => {
    const service = new DjangoAuthService()
    const token = makeToken(validPayload())
    mockedGet.mockRejectedValueOnce(new Error('ETIMEDOUT'))

    await expect(service.introspect(token)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('a network failure on a recently-validated token serves the bounded stale-cache grace window', async () => {
    const service = new DjangoAuthService()
    const token = makeToken(validPayload())
    mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1' } })
    await service.introspect(token) // populates cache

    mockedGet.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const principal = await service.introspect(token)

    expect(principal.userId).toBe('user-1')
  })

  it('the stale-cache grace window is itself bounded — an old cache entry does not survive forever', async () => {
    const service = new DjangoAuthService()
    // Force very small windows for this test via env before construction.
    ;(service as any).positiveTtlMs = 10
    ;(service as any).staleGraceMs = 20

    const token = makeToken(validPayload())
    mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1' } })
    await service.introspect(token)

    await new Promise((r) => setTimeout(r, 40))

    mockedGet.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(service.introspect(token)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('a 4xx (non-401) response from Django is also treated as a definitive rejection', async () => {
    const service = new DjangoAuthService()
    const token = makeToken(validPayload())
    mockedGet.mockRejectedValueOnce({ response: { status: 403, data: {} } })

    await expect(service.introspect(token)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('a 5xx response from Django is treated as a network-class failure, not a definitive rejection', async () => {
    const service = new DjangoAuthService()
    const token = makeToken(validPayload())
    mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1' } })
    await service.introspect(token) // populates cache

    mockedGet.mockRejectedValueOnce({ response: { status: 502, data: {} } })
    const principal = await service.introspect(token)

    expect(principal.userId).toBe('user-1')
  })

  describe('isPremium', () => {
    // Regression: this used to independently re-derive isPremium by
    // comparing data.tier against the literal string "basic" — stale ever
    // since the free tier was renamed to "Free", so every free-tier user
    // was reported as premium. Django's own isPremium (computed from the
    // database-backed tier rank hierarchy) is now trusted directly.
    it('trusts isPremium:false from Django for a free-tier user, even though "Free" !== "basic"', async () => {
      const service = new DjangoAuthService()
      const token = makeToken(validPayload())
      mockedGet.mockResolvedValueOnce({
        status: 200,
        data: { id: 'user-1', tier: 'Free', isPremium: false },
      })

      const principal = await service.introspect(token)

      expect(principal.isPremium).toBe(false)
    })

    it('trusts isPremium:true from Django for a paid-tier user', async () => {
      const service = new DjangoAuthService()
      const token = makeToken(validPayload())
      mockedGet.mockResolvedValueOnce({
        status: 200,
        data: { id: 'user-1', tier: 'Pro', isPremium: true },
      })

      const principal = await service.introspect(token)

      expect(principal.isPremium).toBe(true)
    })

    it('defaults to false when Django omits isPremium entirely, rather than guessing from the tier name', async () => {
      const service = new DjangoAuthService()
      const token = makeToken(validPayload())
      mockedGet.mockResolvedValueOnce({ status: 200, data: { id: 'user-1', tier: 'Pro' } })

      const principal = await service.introspect(token)

      expect(principal.isPremium).toBe(false)
    })
  })
})
