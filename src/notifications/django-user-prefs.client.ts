// src/notifications/django-user-prefs.client.ts

import { Injectable, Logger } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
import { firstValueFrom } from 'rxjs'
import { signedInternalHeaders } from '../security/internal-signing'

@Injectable()
export class DjangoUserPrefsClient {
  private readonly logger = new Logger(DjangoUserPrefsClient.name)
  private readonly cache = new Map<string, { expiresAt: number; data: Record<string, any> | null }>()
  private readonly cacheTtlMs = 60_000 // 1 minute

  constructor(private readonly http: HttpService) {}

  async getNotificationPrefs(userId: string): Promise<Record<string, any> | null> {
    const now = Date.now()
    const cached = this.cache.get(userId)
    if (cached && cached.expiresAt > now) {
      return cached.data
    }

    const base = String(process.env.DJANGO_API_URL ?? process.env.API_BASE_URL ?? '').replace(/\/+$/, '')
    if (!base) return null

    const url = `${base}/api/v1/profile-preferences/me/`

    try {
      const res = await firstValueFrom(
        this.http.get<Record<string, any>>(url, {
          headers: {
            'X-Internal-User-Id': userId,
            ...signedInternalHeaders({
              method: 'GET',
              url,
              secret: process.env.DJANGO_INTERNAL_TOKEN ?? '',
            }),
          },
          timeout: 3000,
        }),
      )

      const prefs: Record<string, any> | null = res?.data?.notification_preferences ?? null
      this.cache.set(userId, { expiresAt: now + this.cacheTtlMs, data: prefs })
      return prefs
    } catch (e: any) {
      this.logger.warn(`[user-prefs] failed to fetch prefs for userId=${userId}: ${e?.message}`)
      this.cache.set(userId, { expiresAt: now + this.cacheTtlMs, data: null })
      return null
    }
  }
}
