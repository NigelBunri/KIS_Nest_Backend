import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { CallsController } from './calls.controller'

// Coverage for two gaps in GET /calls/join/:token (the deep-link/shared-link
// join endpoint, feature J):
// 1. It never checked for a block between the joiner and the call's
//    creator — anyone with the link, including someone the host has
//    blocked, could resolve straight to a joinable call. Every other
//    call-join path (call.offer invitees, call.answer, call.waiting.join)
//    already enforces this; the token-resolve path was the one gap.
// 2. A terminal call's token kept resolving successfully forever (inviteToken
//    is never cleared on end) — stale links should 404, not dangle.

function makeReq() {
  return { headers: { authorization: 'Bearer jwt-token', 'x-device-id': 'device-1' } } as any
}

function makeController(overrides: {
  principal?: any
  call?: any
  blockedIds?: string[]
} = {}) {
  const principal = overrides.principal ?? { userId: 'joiner-1', username: 'Joiner' }
  const authService = { introspect: jest.fn().mockResolvedValue(principal) }
  const call = overrides.call ?? {
    callId: 'call-1',
    conversationId: 'standalone:call-1',
    callType: 'video',
    title: 'Sunday service',
    status: 'pending',
    isStandalone: true,
    scheduledFor: null,
    createdBy: 'host-1',
    participants: [{ userId: 'host-1' }],
  }
  const callsService = { getCallByToken: jest.fn().mockResolvedValue(call) }
  const djangoConversationClient = {
    assertMember: jest.fn(),
    checkBlockedAmong: jest.fn().mockResolvedValue(overrides.blockedIds ?? []),
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
  return { controller, callsService, djangoConversationClient, principal }
}

describe('CallsController.joinByToken (GET /calls/join/:token)', () => {
  it('resolves a valid token to joinable call info', async () => {
    const { controller } = makeController()

    const result = await controller.joinByToken(makeReq(), 'tok-1')

    expect(result).toEqual(expect.objectContaining({ callId: 'call-1', status: 'pending' }))
  })

  it('404s when the token does not resolve to any call', async () => {
    const { controller, callsService } = makeController()
    callsService.getCallByToken.mockResolvedValue(null)

    await expect(controller.joinByToken(makeReq(), 'bad-token')).rejects.toThrow(NotFoundException)
  })

  it('404s a stale link for a call that already ended, instead of resolving it forever', async () => {
    const { controller } = makeController({ call: { callId: 'call-1', createdBy: 'host-1', status: 'ended' } })

    await expect(controller.joinByToken(makeReq(), 'tok-1')).rejects.toThrow(NotFoundException)
  })

  it('rejects a joiner the call creator has blocked', async () => {
    const { controller, djangoConversationClient } = makeController({ blockedIds: ['host-1'] })

    await expect(controller.joinByToken(makeReq(), 'tok-1')).rejects.toThrow(UnauthorizedException)
    expect(djangoConversationClient.checkBlockedAmong).toHaveBeenCalledWith('joiner-1', ['host-1'])
  })

  it('never block-checks the creator against themself (re-opening their own invite link)', async () => {
    const { controller, djangoConversationClient } = makeController({
      principal: { userId: 'host-1', username: 'Host' },
    })

    await controller.joinByToken(makeReq(), 'tok-1')

    expect(djangoConversationClient.checkBlockedAmong).not.toHaveBeenCalled()
  })
})
