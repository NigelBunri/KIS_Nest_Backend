import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DjangoAuthService } from './django-auth.service';

@Injectable()
export class HttpAuthGuard implements CanActivate {
  constructor(private readonly authService: DjangoAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const fromHeader = req?.headers?.authorization;
    const bearer =
      typeof fromHeader === 'string' && fromHeader.startsWith('Bearer ')
        ? fromHeader.slice(7)
        : undefined;

    if (!bearer) {
      throw new UnauthorizedException('Missing token');
    }

    const principal = await this.authService.introspect(bearer);
    req.principal = { ...principal, token: bearer };
    return true;
  }
}
