import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { DjangoAuthService } from './django-auth.service';

@Injectable()
export class WsAuthGuard implements CanActivate {
  constructor(private readonly auth: DjangoAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const client: any = ctx.switchToWs().getClient();
    const fromHeader = client?.handshake?.headers?.authorization;
    const bearer = typeof fromHeader === 'string' && fromHeader.startsWith('Bearer ') ? fromHeader.slice(7) : undefined;

    const token: string | undefined = client?.handshake?.auth?.token || bearer;
    if (!token) throw new UnauthorizedException('Missing token');

    const principal = await this.auth.introspect(token);
    const deviceId = client?.handshake?.auth?.deviceId || client?.handshake?.headers?.['x-device-id'];
    if (principal?.deviceId && deviceId && String(principal.deviceId) !== String(deviceId)) {
      throw new UnauthorizedException('Device mismatch');
    }
    if (principal?.deviceId && !deviceId) {
      throw new UnauthorizedException('Missing device id');
    }
    client.principal = { ...principal, token, deviceId };
    return true;
  }
}
