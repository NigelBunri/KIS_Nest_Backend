// src/chat/features/presence/presence.service.ts
import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * PresenceService:
 * - Right now: placeholder hooks.
 * - Later: store per-user multi-device presence in Redis, lastSeen timestamps, etc.
 */
@Injectable()
export class PresenceService {
  private counts = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  private redis?: Redis;
  private redisReady = false;

  private getRedis(): Redis | undefined {
    if (this.redisReady) return this.redis;
    const url = process.env.REDIS_URL;
    if (!url) {
      this.redisReady = true;
      return undefined;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: true });
    this.redisReady = true;
    return this.redis;
  }

  async markOnline(userId: string) {
    const redis = this.getRedis();
    if (redis) {
      try {
        await redis.incr(`presence:${userId}:count`);
        return;
      } catch {
        // fall through to in-memory on redis failure
      }
    }

    const next = (this.counts.get(userId) ?? 0) + 1;
    this.counts.set(userId, next);
  }

  async markOffline(userId: string) {
    const now = Date.now();
    const redis = this.getRedis();
    if (redis) {
      try {
        const count = await redis.decr(`presence:${userId}:count`);
        if (count <= 0) {
          await redis.set(`presence:${userId}:count`, '0');
          await redis.set(`presence:${userId}:lastSeen`, String(now));
        }
        return;
      } catch {
        // fall through to in-memory on redis failure
      }
    }

    const next = Math.max(0, (this.counts.get(userId) ?? 0) - 1);
    this.counts.set(userId, next);
    if (next === 0) {
      this.lastSeen.set(userId, now);
    }
  }

  async isOnline(userId: string): Promise<boolean> {
    const redis = this.getRedis();
    if (redis) {
      try {
        const raw = await redis.get(`presence:${userId}:count`);
        const count = raw ? Number(raw) : 0;
        return count > 0;
      } catch {
        // fall through to in-memory on redis failure
      }
    }

    return (this.counts.get(userId) ?? 0) > 0;
  }
}
