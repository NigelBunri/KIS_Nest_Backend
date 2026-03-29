import type { FastifyRequest } from 'fastify'
import type { AuthPrincipal } from './auth/django-auth.service'

export type RequestPrincipal = AuthPrincipal & { tenantId?: string }

export function getRequestPrincipal(req: FastifyRequest): RequestPrincipal | undefined {
  return req?.principal as RequestPrincipal | undefined
}

export function resolveTenantId(req: FastifyRequest): string {
  const principal = getRequestPrincipal(req)
  return principal?.tenantId ?? principal?.userId ?? 'anonymous'
}

export function extractIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = (req.headers?.['idempotency-key'] ?? req.headers?.['Idempotency-Key']) as
    | string
    | string[]
    | undefined
  if (!raw) return undefined
  if (Array.isArray(raw)) return raw[0]
  return raw.trim() || undefined
}
