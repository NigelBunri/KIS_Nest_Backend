import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'

@Injectable()
export class InternalAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest()
    const expected = process.env.DJANGO_INTERNAL_TOKEN ?? ''
    const got = req?.headers?.['x-internal-auth'] ?? ''
    if (!expected || got !== expected) {
      throw new UnauthorizedException('Invalid internal auth')
    }
    return true
  }
}
