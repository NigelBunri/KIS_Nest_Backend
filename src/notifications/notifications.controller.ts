import { BadRequestException, Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { DjangoAuthService } from '../auth/django-auth.service';
import { DeviceTokensService } from './device-tokens.service';
import { RateLimitService } from '../chat/infra/rate-limit/rate-limit.service';

type RegisterTokenBody = {
  token?: string;
  platform?: 'android' | 'ios' | 'web';
  deviceId?: string;
  tokenType?: 'fcm' | 'voip';
  token_type?: 'fcm' | 'voip';
};

type UnregisterTokenBody = {
  token?: string;
  deviceId?: string;
};

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly auth: DjangoAuthService,
    private readonly tokens: DeviceTokensService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async authenticate(authorization: string | undefined, deviceId?: string): Promise<string> {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!token) throw new UnauthorizedException('Missing auth token');

    const principal = await this.auth.introspect(token, deviceId);
    if (!principal?.userId) throw new UnauthorizedException('Invalid auth token');
    return String(principal.userId);
  }

  @Post('tokens/register')
  async registerToken(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RegisterTokenBody,
    @Headers('x-device-id') deviceIdHeader?: string,
  ) {
    const userId = await this.authenticate(authorization, deviceIdHeader);
    await this.rateLimit.assert(userId, 'notif:register', 20);

    const pushToken = body?.token ? String(body.token) : '';
    const platform = body?.platform ?? 'android';
    const tokenType = body?.tokenType ?? body?.token_type ?? 'fcm';
    if (!pushToken) return { ok: false, reason: 'token_required' };

    await this.tokens.upsert({
      userId,
      token: pushToken,
      platform,
      deviceId: body?.deviceId,
      tokenType,
    });

    return { ok: true };
  }

  // Logout / account-deletion cleanup. Deactivates (not deletes - keeps the
  // row for audit/debugging, matching Django's soft-delete convention for
  // the same concept) either one exact token, or every token registered
  // for a deviceId if the caller only has that left (e.g. local storage
  // was already partly cleared before this call went out).
  @Post('tokens/unregister')
  async unregisterToken(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UnregisterTokenBody,
    @Headers('x-device-id') deviceIdHeader?: string,
  ) {
    const userId = await this.authenticate(authorization, deviceIdHeader);
    await this.rateLimit.assert(userId, 'notif:unregister', 20);

    const pushToken = body?.token ? String(body.token) : '';
    const deviceId = body?.deviceId ? String(body.deviceId) : '';
    if (!pushToken && !deviceId) {
      throw new BadRequestException('token or deviceId is required');
    }

    if (pushToken) {
      await this.tokens.deactivate({ userId, token: pushToken });
    }
    if (deviceId) {
      await this.tokens.deactivateForDevice({ userId, deviceId });
    }

    return { ok: true };
  }
}
