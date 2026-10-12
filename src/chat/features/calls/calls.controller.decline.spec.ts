import { BadRequestException } from '@nestjs/common'
import { CallsController } from './calls.controller'

// Regression coverage for declining a call directly from the Android
// incoming-call notification's "Decline" action — the one interaction a
// background notification action button must support with NO live socket
// connection and NO need to bring the app to the foreground at all.
// Mirrors the socket call.end handler's own 'rejected' branch
// (setParticipantStatus + endIfNoActiveParticipants, not a blanket
// endCall, so declining in a group call doesn't end it for everyone else).

function makeReq() {
  return { headers: { authorization: 'Bearer jwt-token', 'x-device-id': 'device-1' } } as any
}

function makeController(overrides: { principal?: any; callExists?: boolean } = {}) {
  const principal = overrides.principal ?? { userId: 'recipient-1', username: 'Recipient' }
  const authService = { introspect: jest.fn().mockResolvedValue(principal) }
  const djangoConversationClient = { assertMember: jest.fn().mockResolvedValue(undefined) }
  const callsService = {
    ensureCallExistsOrThrow: overrides.callExists === false
      ? jest.fn().mockRejectedValue(new Error('not found'))
      : jest.fn().mockResolvedValue({ callId: 'call-1', createdBy: 'caller-1' }),
    setParticipantStatus: jest.fn().mockResolvedValue(undefined),
    endIfNoActiveParticipants: jest.fn().mockResolvedValue(undefined),
  }
  const rateLimit = { assert: jest.fn() }
  const emit = jest.fn()
  const to = jest.fn().mockReturnValue({ emit })
  const chatGateway = { server: { to } }

  const controller = new CallsController(
    callsService as any,
    authService as any,
    djangoConversationClient as any,
    rateLimit as any,
    chatGateway as any,
  )
  return { controller, callsService, djangoConversationClient, to, emit, principal }
}

describe('CallsController.decline', () => {
  it('marks the declining participant rejected and ends the call if nobody else is active', async () => {
    const { controller, callsService } = makeController()

    await controller.decline(makeReq(), 'call-1', { conversation_id: 'conv-1' })

    expect(callsService.setParticipantStatus).toHaveBeenCalledWith(
      'conv-1', 'call-1', 'recipient-1', 'rejected', 'rejected',
    )
    expect(callsService.endIfNoActiveParticipants).toHaveBeenCalledWith('conv-1', 'call-1')
  })

  it('broadcasts call.end to the conversation room with reason "rejected", matching what the caller\'s existing socket listener expects', async () => {
    const { controller, to, emit } = makeController()

    await controller.decline(makeReq(), 'call-1', { conversation_id: 'conv-1' })

    expect(to).toHaveBeenCalledWith('conv:conv-1')
    expect(emit).toHaveBeenCalledWith(
      'call.end',
      expect.objectContaining({ callId: 'call-1', conversationId: 'conv-1', fromUserId: 'recipient-1', reason: 'rejected' }),
    )
  })

  it('is a safe no-op for a call that no longer exists (already ended/expired) — never throws', async () => {
    const { controller, callsService, to } = makeController({ callExists: false })

    await expect(
      controller.decline(makeReq(), 'call-1', { conversation_id: 'conv-1' }),
    ).resolves.toBeUndefined()
    expect(callsService.setParticipantStatus).not.toHaveBeenCalled()
    expect(to).not.toHaveBeenCalled()
  })

  it('requires conversation_id', async () => {
    const { controller } = makeController()

    await expect(controller.decline(makeReq(), 'call-1', {})).rejects.toThrow(BadRequestException)
  })

  it('verifies conversation membership before acting — not an open relay', async () => {
    const { controller, djangoConversationClient } = makeController()

    await controller.decline(makeReq(), 'call-1', { conversation_id: 'conv-1' })

    expect(djangoConversationClient.assertMember).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'recipient-1' }),
      'conv-1',
    )
  })
})
