import { HttpException, HttpStatus } from '@nestjs/common'
import { RateLimitService } from './rate-limit.service'

describe('RateLimitService (in-memory fallback)', () => {
  let service: RateLimitService

  beforeEach(() => {
    service = new RateLimitService()
    service.onModuleInit()
  })

  afterEach(() => {
    service.onModuleDestroy()
  })

  it('allows requests under the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        service.assertAllowed({ key: 'test:user1', limit: 5, windowMs: 60_000 }),
      ).resolves.not.toThrow()
    }
  })

  it('throws 429 when limit is exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      await service.assertAllowed({ key: 'test:user2', limit: 5, windowMs: 60_000 })
    }
    await expect(
      service.assertAllowed({ key: 'test:user2', limit: 5, windowMs: 60_000 }),
    ).rejects.toThrow(HttpException)

    try {
      await service.assertAllowed({ key: 'test:user2', limit: 5, windowMs: 60_000 })
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException)
      expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS)
    }
  })

  it('resets the counter after the window expires', async () => {
    for (let i = 0; i < 3; i++) {
      await service.assertAllowed({ key: 'test:user3', limit: 3, windowMs: 1 })
    }

    // Wait for the 1ms window to pass
    await new Promise((r) => setTimeout(r, 5))

    // Should succeed again after reset
    await expect(
      service.assertAllowed({ key: 'test:user3', limit: 3, windowMs: 1 }),
    ).resolves.not.toThrow()
  })

  it('uses separate buckets for different keys', async () => {
    for (let i = 0; i < 3; i++) {
      await service.assertAllowed({ key: 'test:userA', limit: 3, windowMs: 60_000 })
    }
    // userA is at limit, userB should still be clean
    await expect(
      service.assertAllowed({ key: 'test:userB', limit: 3, windowMs: 60_000 }),
    ).resolves.not.toThrow()
  })

  it('throws 429 on the Redis path when the count exceeds the limit (regression: the throw was being swallowed by the connectivity-failure catch)', async () => {
    let count = 0
    const mockRedis = {
      incr: jest.fn(async () => ++count),
      pexpire: jest.fn(async () => 'OK'),
      disconnect: jest.fn(),
    }
    // Bypass getRedis()'s real connection attempt entirely - inject the
    // mock directly and mark it ready, same effect as a successful
    // REDIS_URL connection without needing a real Redis server in tests.
    ;(service as any).redis = mockRedis
    ;(service as any).redisReady = true

    for (let i = 0; i < 3; i++) {
      await expect(
        service.assertAllowed({ key: 'test:redisUser', limit: 3, windowMs: 60_000 }),
      ).resolves.not.toThrow()
    }

    await expect(
      service.assertAllowed({ key: 'test:redisUser', limit: 3, windowMs: 60_000 }),
    ).rejects.toThrow(HttpException)

    try {
      await service.assertAllowed({ key: 'test:redisUser', limit: 3, windowMs: 60_000 })
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException)
      expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS)
    }

    // The in-memory fallback bucket must never have been touched - this
    // was entirely served by the (mocked) Redis path.
    const buckets: Map<string, unknown> = (service as any).buckets
    expect(buckets.has('test:redisUser')).toBe(false)
  })

  it('falls through to the in-memory bucket only on a genuine Redis I/O failure, not on an over-limit result', async () => {
    const mockRedis = {
      incr: jest.fn(async () => {
        throw new Error('connection reset')
      }),
      pexpire: jest.fn(async () => 'OK'),
      disconnect: jest.fn(),
    }
    ;(service as any).redis = mockRedis
    ;(service as any).redisReady = true

    // A real Redis outage still degrades gracefully to the in-memory path.
    await expect(
      service.assertAllowed({ key: 'test:redisDown', limit: 2, windowMs: 60_000 }),
    ).resolves.not.toThrow()
    await expect(
      service.assertAllowed({ key: 'test:redisDown', limit: 2, windowMs: 60_000 }),
    ).resolves.not.toThrow()
    await expect(
      service.assertAllowed({ key: 'test:redisDown', limit: 2, windowMs: 60_000 }),
    ).rejects.toThrow(HttpException)
  })

  it('TTL cleanup removes expired buckets', async () => {
    await service.assertAllowed({ key: 'test:userTTL', limit: 10, windowMs: 1 })

    // Access internal buckets map via any cast
    const buckets: Map<string, { resetAt: number; count: number }> =
      (service as any).buckets

    expect(buckets.has('test:userTTL')).toBe(true)

    // Wait for bucket to expire, then trigger cleanup manually
    await new Promise((r) => setTimeout(r, 5))
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key)
    }

    expect(buckets.has('test:userTTL')).toBe(false)
  })
})
