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

    // Trusted-internal endpoint (apps.chat.internal_auth on the Django
    // side) — NOT /api/v1/profile-preferences/me/. That route requires a
    // real per-user JWT (DeviceBoundJWTAuthentication); this service has
    // never sent one, only the internal HMAC headers below, so every call
    // to /me/ always 401s there. This was a genuine bug: the DND/mute
    // check below has never actually been enforced in production — every
    // push has gone out as if no preference was ever set. See
    // apps/accounts/views_internal.py::NotificationPreferencesInternalView
    // on the Django side.
    const url = `${base}/profile-preferences/internal/notification-prefs/`

    try {
      const res = await firstValueFrom(
        this.http.get<Record<string, any>>(url, {
          params: { user_id: userId },
          headers: {
            'X-Internal-User-Id': userId,
            ...signedInternalHeaders({
              method: 'GET',
              url,
              params: { user_id: userId },
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
