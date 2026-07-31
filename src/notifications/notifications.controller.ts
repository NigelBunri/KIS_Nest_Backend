import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { DjangoAuthService } from '../auth/django-auth.service';
import { DeviceTokensService } from './device-tokens.service';

type RegisterTokenBody = {
  token?: string;
  platform?: 'android' | 'ios' | 'web';
  deviceId?: string;
  tokenType?: 'fcm' | 'voip';
  token_type?: 'fcm' | 'voip';
};

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly auth: DjangoAuthService,
    private readonly tokens: DeviceTokensService,
  ) {}

  @Post('tokens/register')
  async registerToken(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RegisterTokenBody,
  ) {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!token) throw new UnauthorizedException('Missing auth token');

    const principal = await this.auth.introspect(token);
    if (!principal?.userId) throw new UnauthorizedException('Invalid auth token');

    const pushToken = body?.token ? String(body.token) : '';
    const platform = body?.platform ?? 'android';
    const tokenType = body?.tokenType ?? body?.token_type ?? 'fcm';
    if (!pushToken) return { ok: false, reason: 'token_required' };

    await this.tokens.upsert({
      userId: String(principal.userId),
      token: pushToken,
      platform,
      deviceId: body?.deviceId,
      tokenType,
    });

    return { ok: true };
  }
}
