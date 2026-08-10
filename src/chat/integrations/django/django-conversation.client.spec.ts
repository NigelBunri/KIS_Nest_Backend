import { of, throwError } from 'rxjs'
import { UnauthorizedException } from '@nestjs/common'
import { DjangoConversationClient } from './django-conversation.client'
import { SocketPrincipal } from '../../chat.types'

process.env.DJANGO_API_URL = 'https://django.internal.test/api/v1'
process.env.DJANGO_INTERNAL_TOKEN = 'internal-test-token'

function makePrincipal(overrides: Partial<SocketPrincipal> = {}): SocketPrincipal {
  return { userId: 'user-1', token: 'jwt-token-abc', ...overrides }
}

function makeMetrics() {
  return { inc: jest.fn(), observeMs: jest.fn() } as any
}

describe('DjangoConversationClient.wsPerms — fail-closed authorization', () => {
  beforeEach(() => {
    jest.useRealTimers()
  })

  it('returns and caches a successful membership result', async () => {
    const http = { get: jest.fn().mockReturnValue(of({ data: { isMember: true, isBlocked: false, canSend: true } })) }
    const metrics = makeMetrics()
    const client = new DjangoConversationClient(http as any, metrics)

    const result = await client.wsPerms(makePrincipal(), 'conv-1')

    expect(result.isMember).toBe(true)
    expect(http.get).toHaveBeenCalledTimes(1)
  })

  it('serves the cached positive result without a second network call', async () => {
    const http = { get: jest.fn().mockReturnValue(of({ data: { isMember: true, isBlocked: false, canSend: true } })) }
    const client = new DjangoConversationClient(http as any, makeMetrics())

    await client.wsPerms(makePrincipal(), 'conv-2')
    await client.wsPerms(makePrincipal(), 'conv-2')

    expect(http.get).toHaveBeenCalledTimes(1)
  })

  it('an explicit 4xx from Django is a hard denial', async () => {
    const http = { get: jest.fn().mockReturnValue(throwError(() => ({ response: { status: 403 } }))) }
    const client = new DjangoConversationClient(http as any, makeMetrics())

    await expect(client.wsPerms(makePrincipal(), 'conv-3')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('REGRESSION: a network error with no prior cache now denies instead of fabricating membership', async () => {
    const http = { get: jest.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED'))) }
    const client = new DjangoConversationClient(http as any, makeMetrics())

    await expect(client.wsPerms(makePrincipal(), 'conv-4')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('a 5xx from Django with no prior cache also denies', async () => {
    const http = { get: jest.fn().mockReturnValue(throwError(() => ({ response: { status: 503 } }))) }
    const client = new DjangoConversationClient(http as any, makeMetrics())

    await expect(client.wsPerms(makePrincipal(), 'conv-5')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('records a metric with a reason label on every fail-closed denial', async () => {
    const http = { get: jest.fn().mockReturnValue(throwError(() => new Error('ETIMEDOUT'))) }
    const metrics = makeMetrics()
    const client = new DjangoConversationClient(http as any, metrics)

    await expect(client.wsPerms(makePrincipal(), 'conv-6')).rejects.toBeInstanceOf(UnauthorizedException)

    expect(metrics.inc).toHaveBeenCalledWith(
      'chat_conversation_perms_fail_closed_total',
      expect.objectContaining({ reason: 'network_error' }),
    )
  })

  it('still serves a fresh stale-cache entry on network failure — legitimate resilience, not fail-open', async () => {
    const http = { get: jest.fn() }
    const client = new DjangoConversationClient(http as any, makeMetrics())

    http.get.mockReturnValueOnce(of({ data: { isMember: true, isBlocked: false, canSend: true } }))
    await client.wsPerms(makePrincipal(), 'conv-7') // populates cache

    // Force the fresh-cache TTL to have already elapsed but the stale
    // window to still be open, so the next call actually reaches the
    // (now failing) HTTP client instead of being served straight from the
    // fresh cache.
    ;(client as any).permsTtlMs = 1
    await new Promise((r) => setTimeout(r, 5))

    http.get.mockReturnValueOnce(throwError(() => new Error('ECONNREFUSED')))
    const result = await client.wsPerms(makePrincipal(), 'conv-7')

    expect(result.isMember).toBe(true)
  })

  it('opens the circuit after consecutive network failures and denies immediately without another HTTP attempt', async () => {
    const http = { get: jest.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED'))) }
    const client = new DjangoConversationClient(http as any, makeMetrics())
    ;(client as any).circuitFailureThreshold = 2

    await expect(client.wsPerms(makePrincipal(), 'conv-8a')).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(client.wsPerms(makePrincipal(), 'conv-8b')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(http.get).toHaveBeenCalledTimes(2)

    // Circuit should now be open — a third call must deny WITHOUT calling HTTP again.
    await expect(client.wsPerms(makePrincipal(), 'conv-8c')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(http.get).toHaveBeenCalledTimes(2)
  })

  it('a successful call resets the circuit breaker', async () => {
    const http = { get: jest.fn() }
    const client = new DjangoConversationClient(http as any, makeMetrics())
    ;(client as any).circuitFailureThreshold = 2

    http.get.mockReturnValueOnce(throwError(() => new Error('ECONNREFUSED')))
    await expect(client.wsPerms(makePrincipal(), 'conv-9a')).rejects.toBeInstanceOf(UnauthorizedException)

    http.get.mockReturnValueOnce(of({ data: { isMember: true, isBlocked: false, canSend: true } }))
    await client.wsPerms(makePrincipal(), 'conv-9b')

    expect((client as any).consecutiveFailures).toBe(0)
    expect((client as any).circuitOpenUntil).toBe(0)
  })

  it('4xx denials do not count toward the circuit breaker', async () => {
    const http = { get: jest.fn().mockReturnValue(throwError(() => ({ response: { status: 401 } }))) }
    const client = new DjangoConversationClient(http as any, makeMetrics())
    ;(client as any).circuitFailureThreshold = 2

    await expect(client.wsPerms(makePrincipal(), 'conv-10a')).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(client.wsPerms(makePrincipal(), 'conv-10b')).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(client.wsPerms(makePrincipal(), 'conv-10c')).rejects.toBeInstanceOf(UnauthorizedException)

    // All three should have actually reached Django — none short-circuited
    // by an (incorrectly) opened breaker.
    expect(http.get).toHaveBeenCalledTimes(3)
  })

  it('broadcast conversations still bypass Django entirely, unaffected by this change', async () => {
    const http = { get: jest.fn() }
    const client = new DjangoConversationClient(http as any, makeMetrics())

    const result = await client.wsPerms(makePrincipal(), 'broadcast:channel-123')

    expect(result.isMember).toBe(true)
    expect(http.get).not.toHaveBeenCalled()
  })
})
