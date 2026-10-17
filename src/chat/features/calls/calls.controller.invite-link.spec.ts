import { NotFoundException } from '@nestjs/common'
import { CallsController } from './calls.controller'

// Regression coverage for feature J (join via shared link): POST
// /calls/invite-link used to return inviteLink as a bare `kis://` custom
// scheme, and a separate (also wrong — wrong path shape) `webLink` field
// nobody consumed. A custom scheme only ever opens from inside the app
// itself; tapped from Messages/Mail/a browser it does nothing, which a
// shared call invite cannot depend on. The real link must be an https://
// Universal Link matching both the website's actual join page
// (app/join/[type]/[token]/page.tsx) and this app's own InviteJoin linking
// route ('join/:type/:token').

function makeReq() {
  return { headers: { authorization: 'Bearer jwt-token', 'x-device-id': 'device-1' } } as any
}

function makeController(overrides: { token?: string | null } = {}) {
  const principal = { userId: 'host-1', username: 'Host' }
  const authService = { introspect: jest.fn().mockResolvedValue(principal) }
  const djangoConversationClient = { assertMember: jest.fn() }
  const callsService = {
    getOrCreateInviteToken: jest.fn().mockResolvedValue(overrides.token === undefined ? 'tok-abc123' : overrides.token),
  }
  const rateLimit = { assert: jest.fn() }
  const chatGateway = { server: { to: jest.fn().mockReturnValue({ emit: jest.fn() }) } }

  const controller = new CallsController(
    callsService as any,
    authService as any,
    djangoConversationClient as any,
    rateLimit as any,
    chatGateway as any,
  )
  return { controller, callsService }
}

describe('CallsController.createInviteLink (POST /calls/invite-link)', () => {
  const ORIGINAL_ENV = process.env.KIS_WEBSITE_PUBLIC_BASE_URL

  afterEach(() => {
    process.env.KIS_WEBSITE_PUBLIC_BASE_URL = ORIGINAL_ENV
  })

  it('returns a real https:// Universal Link, not a bare custom scheme', async () => {
    delete process.env.KIS_WEBSITE_PUBLIC_BASE_URL
    const { controller } = makeController()

    const result = await controller.createInviteLink(makeReq(), { conversation_id: 'standalone:call-1', call_id: 'call-1' })

    expect(result.inviteLink).toBe('https://kingdomimpactventures.org/join/call/tok-abc123')
    expect(result.inviteLink.startsWith('https://')).toBe(true)
  })

  it('matches the website\'s real join-page path shape (join/:type/:token), not call/join/:token', async () => {
    const { controller } = makeController()

    const result = await controller.createInviteLink(makeReq(), { conversation_id: 'standalone:call-1', call_id: 'call-1' })

    expect(result.inviteLink).toContain('/join/call/')
    expect(result.inviteLink).not.toContain('/call/join/')
  })

  it('respects KIS_WEBSITE_PUBLIC_BASE_URL when set', async () => {
    process.env.KIS_WEBSITE_PUBLIC_BASE_URL = 'https://staging.example.org'
    const { controller } = makeController()

    const result = await controller.createInviteLink(makeReq(), { conversation_id: 'standalone:call-1', call_id: 'call-1' })

    expect(result.inviteLink).toBe('https://staging.example.org/join/call/tok-abc123')
  })

  it('404s when the call is not found or already ended', async () => {
    const { controller } = makeController({ token: null })

    await expect(
      controller.createInviteLink(makeReq(), { conversation_id: 'standalone:call-1', call_id: 'call-1' }),
    ).rejects.toThrow(NotFoundException)
  })
})
