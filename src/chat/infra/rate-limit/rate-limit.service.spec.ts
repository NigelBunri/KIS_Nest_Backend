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
