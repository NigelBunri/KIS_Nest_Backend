import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import crypto from 'crypto';

import {
  internalSignaturesRequired,
  verifyInternalSignature,
} from '../security/internal-signing';

@Injectable()
export class InternalAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const expected = process.env.DJANGO_INTERNAL_TOKEN ?? '';
    const got = req?.headers?.['x-internal-auth'] ?? '';
    const tokenMatches =
      Boolean(expected) &&
      typeof got === 'string' &&
      expected.length === got.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
    if (!tokenMatches) {
      console.warn('internal_auth.failed', {
        reason: 'invalid_token',
        path: req?.url,
        method: req?.method,
      });
      throw new UnauthorizedException('Invalid internal auth');
    }

    const verification = verifyInternalSignature({
      method: req?.method ?? 'GET',
      url: req?.url ?? '/',
      body: req?.body,
      headers: req?.headers ?? {},
      secret: expected,
    });
    if (verification.ok) return true;

    if (internalSignaturesRequired()) {
      console.warn('internal_auth.failed', {
        reason: verification.reason,
        path: req?.url,
        method: req?.method,
      });
      throw new UnauthorizedException('Invalid internal auth');
    }

    console.info('internal_auth.legacy_token_allowed', {
      reason: verification.reason,
      path: req?.url,
      method: req?.method,
    });
    return true;
  }
}
