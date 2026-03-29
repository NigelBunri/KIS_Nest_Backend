// src/chat/infra/rate-limit/rate-limit.service.ts

import { Injectable, HttpException, HttpStatus } from '@nestjs/common'
import Redis from 'ioredis'
import type { SocketPrincipal } from '../../chat.types'

type Bucket = { resetAt: number; count: number }

@Injectable()
export class RateLimitService {
  private buckets = new Map<string, Bucket>()
  private redis?: Redis
  private redisReady = false

  private getRedis(): Redis | undefined {
    if (this.redisReady) return this.redis
    const url = process.env.REDIS_URL
    if (!url) {
      this.redisReady = true
      return undefined
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: true })
    this.redisReady = true
    return this.redis
  }

  /**
   * ✅ Handler-compatible assert(principal, key, limit?)
   * Used by realtime handlers.
   */
  async assert(principal: SocketPrincipal | string, key: string, limit = 60) {
    const userId = typeof principal === 'string' ? principal : principal.userId

    // default window policy (you can tune)
    const windowMs =
      key.startsWith('send:') ? 5_000 :
      key.startsWith('edit:') ? 60_000 :
      key.startsWith('delete:') ? 60_000 :
      60_000

    const bucketKey = `${key}:${userId}`

    await this.assertAllowed({ key: bucketKey, limit, windowMs })
  }

  /**
   * ✅ Backward-compatible style: assert(userId, action)
   * Keep if other parts of code call it.
   */
  async assertLegacy(userId: string, action: string) {
    const key = `${action}:${userId}`
    const limit = action === 'send' ? 25 : 60
    const windowMs = action === 'send' ? 5_000 : 60_000
    await this.assertAllowed({ key, limit, windowMs })
  }

  async assertAllowed(opts: { key: string; limit: number; windowMs: number }) {
    const redis = this.getRedis()
    if (redis) {
      try {
        const count = await redis.incr(opts.key)
        if (count === 1) {
          await redis.pexpire(opts.key, opts.windowMs)
        }
        if (count > opts.limit) {
          throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS)
        }
        return
      } catch {
        // fall through to in-memory on redis failure
      }
    }

    const now = Date.now()
    const b = this.buckets.get(opts.key)

    if (!b || now >= b.resetAt) {
      this.buckets.set(opts.key, { resetAt: now + opts.windowMs, count: 1 })
      return
    }

    b.count += 1

    if (b.count > opts.limit) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS)
    }
  }
}
