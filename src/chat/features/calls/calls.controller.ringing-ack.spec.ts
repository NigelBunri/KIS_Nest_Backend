import { BadRequestException } from '@nestjs/common'
import { CallsController } from './calls.controller'

// Regression coverage for the Calling→Ringing device-acknowledgement path
// that works even when the recipient has no live socket connection at all
// (fully backgrounded/killed, woken only by an FCM push into a headless JS
// context). The EXISTING socket-based `call.ringing` event (see
// realtime/handlers/calls.ts) already correctly implements a genuine
// device acknowledgement for the live-socket case — this HTTP endpoint
// mirrors its exact logic (creator lookup, targeted emit, best-effort
// no-op on a miss) for the one path sockets can't reach, reusing the SAME
// event name/payload shape so the caller's existing listener needs no
// changes at all.

function makeReq(overrides: Partial<{ authorization: string; deviceId: string }> = {}) {
  return {
    headers: {
      authorization: overrides.authorization ?? 'Bearer jwt-token',
      'x-device-id': overrides.deviceId ?? 'device-1',
    },
  } as any
}

function makeController(overrides: {
  principal?: any
  creatorId?: string | null
} = {}) {
  const principal = overrides.principal ?? { userId: 'responder-1', username: 'Responder' }
  const authService = { introspect: jest.fn().mockResolvedValue(principal) }
  const djangoConversationClient = { assertMember: jest.fn().mockResolvedValue(undefined) }
  const callsService = {
    getCallCreator: jest.fn().mockResolvedValue('creatorId' in overrides ? overrides.creatorId : 'caller-1'),
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

describe('CallsController.ackRinging', () => {
  it('emits call.ringing to the call creator\'s room, not the responder\'s own', async () => {
    const { controller, to, emit } = makeController({ creatorId: 'caller-1' })

    await controller.ackRinging(makeReq(), 'call-1', { conversation_id: 'conv-1' })

    expect(to).toHaveBeenCalledWith('user:caller-1')
    expect(emit).toHaveBeenCalledWith(
      'call.ringing',
      expect.objectContaining({ callId: 'call-1', conversationId: 'conv-1', fromUserId: 'responder-1' }),
    )
  })

  it('does not emit at all when the creator could not be resolved (stale/ended call) — best-effort, non-fatal', async () => {
    const { controller, to } = makeController({ creatorId: null })

    await expect(
      controller.ackRinging(makeReq(), 'call-1', { conversation_id: 'conv-1' }),
    ).resolves.toBeUndefined()
    expect(to).not.toHaveBeenCalled()
  })

  it('does not emit when the creator ack-ing their own call (self), only ever targets the OTHER party', async () => {
    const { controller, to } = makeController({
      principal: { userId: 'caller-1', username: 'Caller' },
      creatorId: 'caller-1',
    })

    await controller.ackRinging(makeReq(), 'call-1', { conversation_id: 'conv-1' })

    expect(to).not.toHaveBeenCalled()
  })

  it('requires conversation_id', async () => {
    const { controller } = makeController()

    await expect(
      controller.ackRinging(makeReq(), 'call-1', {}),
    ).rejects.toThrow(BadRequestException)
  })

  it('verifies conversation membership before acknowledging — not an open relay', async () => {
    const { controller, djangoConversationClient } = makeController()

    await controller.ackRinging(makeReq(), 'call-1', { conversation_id: 'conv-1' })

    expect(djangoConversationClient.assertMember).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'responder-1' }),
      'conv-1',
    )
  })
})
