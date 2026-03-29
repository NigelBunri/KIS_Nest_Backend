import { Injectable, UnauthorizedException } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import crypto from 'crypto';
import https from 'https';

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

@Injectable()
export class DjangoAuthService {
  private readonly sharedJwtSecret = (process.env.DJANGO_JWT_SECRET ?? process.env.JWT_SECRET ?? '').trim();
  private readonly tokenIssuer = (process.env.DJANGO_JWT_ISSUER ?? process.env.JWT_ISSUER ?? '').trim();
  private readonly tokenAudience = (process.env.DJANGO_JWT_AUDIENCE ?? process.env.JWT_AUDIENCE ?? '').trim();

  async introspect(token: string): Promise<AuthPrincipal> {
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

    try {
      const { data, status } = await axios.get(url, {
        headers: {
          Authorization: `${scheme} ${token}`,
          'X-Internal-Auth': internal,
          Accept: 'application/json',
        },
        timeout: 4000,
        httpsAgent,
      });

      return this.mapDjangoPayload(data, status);
    } catch (e) {
      const err = e as AxiosError;
      const status = err.response?.status;
      const body = err.response?.data;
      console.error('❌ Introspection error', {
        url,
        status,
        body,
        scheme,
        token: redact(token),
      });

      if (this.sharedJwtSecret) {
        try {
          const payload = this.decodeAndValidateJwt(token);
          console.warn('⚠️ Falling back to local JWT verification', {
            userId: payload?.user_id ?? payload?.sub,
          });
          return this.mapPayloadToPrincipal(payload);
        } catch (localError) {
          console.error('❌ Local JWT verification failed', localError);
        }
      }

      throw new UnauthorizedException('Invalid token');
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
      String(
        data?.username ??
        data?.display_name ??
        (data?.email ? data.email.split('@')[0] : '') ??
        'user'
      );

    const isPremium =
      Boolean(
        data?.isPremium ??
        (typeof data?.tier === 'string' && data.tier.toLowerCase() !== 'basic') ??
        data?.entitlements?.premium === true
      );

    const scopes =
      Array.isArray(data?.scopes)
        ? data.scopes
        : (data?.entitlements && typeof data.entitlements === 'object')
          ? Object.keys(data.entitlements).filter((k) => data.entitlements[k] === true)
          : [];

    const deviceId = data?.device_id ?? data?.deviceId ?? undefined;

    return { userId, username, isPremium, deviceId: deviceId ? String(deviceId) : undefined, scopes };
  }

  private decodeAndValidateJwt(token: string) {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const [header, payload, signature] = parts;
    const signingInput = `${header}.${payload}`;
    const expectedSig = crypto.createHmac('sha256', this.sharedJwtSecret).update(signingInput).digest('base64url');
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
    if (this.tokenIssuer && decoded.iss !== this.tokenIssuer) {
      throw new Error('Invalid token issuer');
    }
    if (this.tokenAudience) {
      const audClaim = decoded.aud;
      const validAudience = Array.isArray(audClaim) ? audClaim.includes(this.tokenAudience) : audClaim === this.tokenAudience;
      if (!validAudience) {
        throw new Error('Invalid token audience');
      }
    }

    return decoded;
  }

  private base64UrlDecode(value: string) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  }

  private mapPayloadToPrincipal(payload: Record<string, any>): AuthPrincipal {
    const userId = String(payload?.user_id ?? payload?.sub ?? payload?.id ?? '');
    if (!userId) {
      throw new UnauthorizedException('Token payload missing user id');
    }

    const username =
      String(
        payload?.username ??
        payload?.display_name ??
        (payload?.email ? (payload.email as string).split('@')[0] : '') ??
        'user'
      );

    const isPremium =
      Boolean(
        payload?.isPremium ??
        (typeof payload?.tier === 'string' && payload.tier.toLowerCase() !== 'basic')
      );

    const scopes =
      Array.isArray(payload?.scopes)
        ? payload.scopes
        : (payload?.entitlements && typeof payload.entitlements === 'object')
          ? Object.keys(payload.entitlements).filter((k) => payload.entitlements[k] === true)
          : [];

    const deviceId = payload?.device_id ?? payload?.deviceId ?? undefined;

    return { userId, username, isPremium, deviceId: deviceId ? String(deviceId) : undefined, scopes };
  }
}
