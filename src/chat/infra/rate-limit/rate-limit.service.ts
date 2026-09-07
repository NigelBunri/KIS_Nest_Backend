// src/chat/infra/rate-limit/rate-limit.service.ts

import { Injectable, HttpException, HttpStatus, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import type { SocketPrincipal } from '../../chat.types'

type Bucket = { resetAt: number; count: number }

const BUCKET_CLEANUP_INTERVAL_MS = 60_000

@Injectable()
export class RateLimitService implements OnModuleInit, OnModuleDestroy {
  private buckets = new Map<string, Bucket>()
  private redis?: Redis
  private redisReady = false
  private cleanupTimer?: ReturnType<typeof setInterval>

  onModuleInit() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, bucket] of this.buckets) {
        if (now >= bucket.resetAt) this.buckets.delete(key)
      }
    }, BUCKET_CLEANUP_INTERVAL_MS)
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.redis?.disconnect()
  }

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
      // Only the Redis I/O itself (a dropped connection, a command
      // timeout) is allowed to fall through to the in-memory bucket below.
      // The over-limit decision is computed from that I/O's result and
      // must never be caught here - it used to sit inside this same try
      // block, so the deliberate "too many requests" throw was being
      // swallowed by the catch meant only for connectivity failures,
      // silently degrading every Redis-backed rate limit in production to
      // an in-memory-only limiter that resets on every restart and never
      // shares state across instances.
      let count: number
      try {
        count = await redis.incr(opts.key)
        if (count === 1) {
          await redis.pexpire(opts.key, opts.windowMs)
        }
      } catch {
        count = -1 // sentinel: Redis I/O failed, fall through below
      }
      if (count >= 0) {
        if (count > opts.limit) {
          throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS)
        }
        return
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
