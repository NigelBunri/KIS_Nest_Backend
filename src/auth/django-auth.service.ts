import { Injectable, UnauthorizedException } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import crypto from 'crypto';
import https from 'https';
import { signedInternalHeaders } from '../security/internal-signing';

export type AuthPrincipal = {
  userId: string;
  username: string;
  isPremium: boolean;
  deviceId?: string;
  scopes?: string[];
};

function redact(token: string) {
  if (!token) return '';
  return token.length <= 10 ? '***' : token.slice(0, 6) + '…' + token.slice(-4);
}

function ensureTrailingSlash(u: string) {
  if (!u) throw new Error('DJANGO_INTROSPECT_URL is not configured');
  return u.endsWith('/') ? u : u + '/';
}

/**
 * Authoritative token validation for the whole Nest.js service (REST, WS,
 * every controller below all funnel through introspect()).
 *
 * Design note (device revocation): a token that merely has a valid
 * signature and hasn't expired is NOT sufficient to grant access — Django's
 * /auth/introspect/ endpoint is the only thing that knows whether the
 * device backing this token has since been revoked (logout, single-device
 * revoke, bulk revoke). Local JWT decoding below exists ONLY as a fast
 * local rejection of obviously-bad tokens (bad signature, expired) so a
 * garbage token doesn't cost a network round trip — it is never, by
 * itself, sufficient to accept a token. Only a successful Django round
 * trip (live, or served from a short, bounded-TTL cache populated by one)
 * authorizes access, and a network failure reaching Django never manufactures
 * a session that was never actually validated.
 */
@Injectable()
export class DjangoAuthService {
  private readonly sharedJwtSecret = (
    process.env.DJANGO_JWT_SECRET ??
    process.env.JWT_SECRET ??
    ''
  ).trim();
  private readonly strictJwtClaims =
    ((process.env.DJANGO_JWT_STRICT ?? process.env.JWT_STRICT ?? '').trim() ||
      (process.env.NODE_ENV === 'production' ? '1' : '0')) === '1';
  private readonly tokenIssuers = this.buildAllowedValues([
    process.env.DJANGO_JWT_ISSUER,
    process.env.JWT_ISSUER,
    process.env.DJANGO_BASE_URL,
    this.getOrigin(process.env.DJANGO_INTROSPECT_URL),
  ]);
  private readonly tokenAudiences = this.buildAllowedValues([
    process.env.DJANGO_JWT_AUDIENCE,
    process.env.JWT_AUDIENCE,
  ]);

  // Bounded revocation-propagation window: how long a successful
  // introspection result may be reused before Django must be asked again.
  // Keep short — this IS the upper bound on "how long after a device is
  // revoked can it still act through Nest.js".
  private readonly positiveTtlMs = Number(
    process.env.DJANGO_INTROSPECT_CACHE_TTL_MS ?? 30_000,
  );
  // Resilience window for a token that was ALREADY validated recently, used
  // only when Django is unreachable (network error/timeout/5xx) — never for
  // a token with no prior successful validation, and never when Django
  // gives an explicit rejection.
  private readonly staleGraceMs = Number(
    process.env.DJANGO_INTROSPECT_STALE_GRACE_MS ?? 90_000,
  );
  private readonly principalCache = new Map<
    string,
    { principal: AuthPrincipal; validatedAt: number }
  >();

  async introspect(token: string, deviceId?: string): Promise<AuthPrincipal> {
    if (this.sharedJwtSecret) {
      try {
        this.decodeAndValidateJwt(token);
      } catch (localError: any) {
        throw new UnauthorizedException('Invalid token');
      }
    }

    const cacheKey = this.cacheKeyFor(token, deviceId);
    const now = Date.now();
    const cached = this.principalCache.get(cacheKey);
    if (cached && now - cached.validatedAt < this.positiveTtlMs) {
      return cached.principal;
    }

    try {
      const principal = await this.fetchFromDjango(token, deviceId);
      this.principalCache.set(cacheKey, { principal, validatedAt: now });
      return principal;
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        // Definitive rejection (or fatal misconfiguration) — never mask
        // this behind a stale cache hit, and don't let a now-invalid
        // token keep passing from cache for the rest of its TTL window.
        this.principalCache.delete(cacheKey);
        throw e;
      }
      // Network error / timeout / 5xx reaching Django. A token with no
      // prior successful validation has no cache entry — deny outright
      // rather than letting an unreachable Django manufacture a session
      // that was never actually checked.
      if (cached && now - cached.validatedAt < this.staleGraceMs) {
        return cached.principal;
      }
      throw new UnauthorizedException('Invalid token');
    }
  }

  private cacheKeyFor(token: string, deviceId?: string): string {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    return deviceId ? `${hash}:${deviceId}` : hash;
  }

  private async fetchFromDjango(token: string, deviceId?: string): Promise<AuthPrincipal> {
    const rawUrl = process.env.DJANGO_INTROSPECT_URL;
    if (!rawUrl) {
      throw new UnauthorizedException('DJANGO_INTROSPECT_URL is missing');
    }
    const url = ensureTrailingSlash(rawUrl); // avoid 301 hops
    const internal = process.env.DJANGO_INTERNAL_TOKEN!;
    const scheme = (process.env.DJANGO_AUTH_SCHEME ?? 'Bearer').trim(); // Bearer or JWT
    const allowSelfSigned = (process.env.DJANGO_TLS_INSECURE ?? '0') === '1';

    const httpsAgent = url.startsWith('https')
      ? new https.Agent({ rejectUnauthorized: !allowSelfSigned })
      : undefined;

    const headers: Record<string, string> = {
      Authorization: `${scheme} ${token}`,
      ...signedInternalHeaders({ method: 'GET', url, secret: internal }),
      Accept: 'application/json',
    };
    // Optional — Nest is relaying a client's token, not originating the
    // request, so there may be no device id to forward. Django's
    // introspection endpoint cross-checks it when present but does not
    // require it (see apps.accounts.jwt_auth.validate_device_bound_token).
    if (deviceId) {
      headers['X-Device-Id'] = deviceId;
    }

    try {
      const { data, status } = await axios.get(url, { headers, timeout: 4000, httpsAgent });
      return this.mapDjangoPayload(data, status);
    } catch (e) {
      const err = e as AxiosError;
      const status = err.response?.status;
      console.error('❌ Introspection error', {
        url,
        status,
        scheme,
        token: redact(token),
      });

      if (status && status >= 400 && status < 500) {
        throw new UnauthorizedException('Invalid token');
      }
      // Network error / timeout / 5xx — rethrow as-is (not
      // UnauthorizedException) so introspect() can apply the bounded
      // stale-cache grace window instead of an immediate hard failure.
      throw e;
    }
  }

  private mapDjangoPayload(data: any, status: number) {
    const userId = String(data?.userId ?? data?.id ?? '');
    if (!userId) {
      console.error('Introspection success 200 but no user id field found', {
        status,
        keys: data ? Object.keys(data) : [],
      });
      throw new UnauthorizedException('Invalid token payload');
    }

    const username =
      [
        data?.display_name,
        data?.username,
        data?.email ? data.email.split('@')[0] : '',
      ]
        .map((value) => String(value ?? '').trim())
        .find(Boolean) ?? 'User';

    // Trust Django's isPremium directly — it's now computed from the
    // database-backed AccountTier.rank hierarchy (apps.accounts.tiers.
    // is_paid_tier_name), which is alias-aware (e.g. legacy "Basic" ->
    // "Free") and always current. The stale local fallback this used to
    // have — comparing the tier name against the literal string "basic" —
    // was wrong ever since the free tier was renamed to "Free", and
    // reported every free-tier user as premium.
    const isPremium = Boolean(data?.isPremium);

    const scopes = Array.isArray(data?.scopes)
      ? data.scopes
      : data?.entitlements && typeof data.entitlements === 'object'
        ? Object.keys(data.entitlements).filter(
            (k) => data.entitlements[k] === true,
          )
        : [];

    const deviceId = data?.device_id ?? data?.deviceId ?? undefined;

    return {
      userId,
      username,
      isPremium,
      deviceId: deviceId ? String(deviceId) : undefined,
      scopes,
    };
  }

  /**
   * Fast local rejection only (signature/exp/nbf/iss/aud) — throws on an
   * obviously-invalid token so it never costs a network round trip.
   * Passing this check does NOT authorize anything by itself; only
   * fetchFromDjango()'s result (live or cached) does.
   */
  private decodeAndValidateJwt(token: string): void {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const [header, payload, signature] = parts;
    const signingInput = `${header}.${payload}`;
    const expectedSig = crypto
      .createHmac('sha256', this.sharedJwtSecret)
      .update(signingInput)
      .digest('base64url');
    if (signature !== expectedSig) {
      throw new Error('Invalid JWT signature');
    }

    const decoded = JSON.parse(this.base64UrlDecode(payload));
    const now = Math.floor(Date.now() / 1000);

    if (typeof decoded.exp === 'number' && now >= decoded.exp) {
      throw new Error('Token expired');
    }
    if (typeof decoded.nbf === 'number' && now < decoded.nbf) {
      throw new Error('Token not active yet');
    }
    if (this.tokenIssuers.length > 0) {
      const tokenIssuer = decoded.iss;
      const issuerOk =
        !this.strictJwtClaims && tokenIssuer == null
          ? true
          : this.tokenIssuers.includes(String(tokenIssuer ?? ''));
      if (!issuerOk) {
        const error = new Error('Invalid token issuer');
        if (this.strictJwtClaims) throw error;
        console.warn('⚠️ Accepting JWT with issuer drift in non-strict mode', {
          tokenIssuer: decoded.iss,
          allowedIssuers: this.tokenIssuers,
        });
      }
    }
    if (this.tokenAudiences.length > 0) {
      const audClaim = decoded.aud;
      const validAudience =
        !this.strictJwtClaims && audClaim == null
          ? true
          : Array.isArray(audClaim)
            ? audClaim.some((aud) => this.tokenAudiences.includes(String(aud)))
            : this.tokenAudiences.includes(String(audClaim ?? ''));
      if (!validAudience) {
        const error = new Error('Invalid token audience');
        if (this.strictJwtClaims) throw error;
        console.warn(
          '⚠️ Accepting JWT with audience drift in non-strict mode',
          {
            tokenAudience: audClaim,
            allowedAudiences: this.tokenAudiences,
          },
        );
      }
    }
  }

  private base64UrlDecode(value: string) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  }

  private buildAllowedValues(values: Array<string | undefined>) {
    return Array.from(
      new Set(
        values
          .flatMap((value) => String(value ?? '').split(','))
          .map((value) => value.trim().replace(/\/$/, ''))
          .filter(Boolean),
      ),
    );
  }

  private getOrigin(value?: string) {
    if (!value) return '';
    try {
      return new URL(value).origin;
    } catch {
      return '';
    }
  }
}
