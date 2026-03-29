import type { AuthPrincipal } from '../auth/django-auth.service'

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthPrincipal & { tenantId?: string }
  }
}
