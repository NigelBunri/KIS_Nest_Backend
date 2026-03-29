import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'
import type { AuthPrincipal } from './auth/django-auth.service'

export const SCOPES_KEY = 'requiredScopes'
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes)

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!requiredScopes?.length) return true

    const req = context.switchToHttp().getRequest<FastifyRequest>()
    const principal = req?.principal as AuthPrincipal | undefined
    const userScopes = Array.isArray(principal?.scopes) ? principal?.scopes : []
    return requiredScopes.every((scope) => userScopes.includes(scope))
  }
}
