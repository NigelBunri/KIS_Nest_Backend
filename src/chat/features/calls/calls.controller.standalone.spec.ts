import { BadRequestException } from '@nestjs/common'
import { CallsController } from './calls.controller'

// POST /calls/standalone - the "New call" creation endpoint. Covers the
// broadcast panelist-count validation (1-30, server-side defense in depth
// alongside the mobile picker's own cap) and scheduledDurationMinutes
// storage (5 min - 24 h, only meaningful for a scheduled call).

function makeReq() {
  return { headers: { authorization: 'Bearer jwt', 'x-device-id': 'dev-1' } } as any
}

function makeController(overrides: { createStandaloneCall?: jest.Mock } = {}) {
  const createStandaloneCall =
    overrides.createStandaloneCall ??
    jest.fn().mockResolvedValue({
      callId: 'call-1',
      conversationId: 'standalone:call-1',
      inviteToken: 'tok-1',
      callType: 'voice',
      title: 'My call',
      scheduledFor: null,
      scheduledDurationMinutes: null,
      isStandalone: true,
    })
  const callsService: any = { createStandaloneCall }
  const authService: any = { introspect: jest.fn().mockResolvedValue({ userId: 'user-1', username: 'Caller' }) }
  const djangoConversationClient: any = {}
  const rateLimit: any = { assert: jest.fn() }
  const chatGateway: any = {}
  const controller = new CallsController(callsService, authService, djangoConversationClient, rateLimit, chatGateway)
  return { controller, createStandaloneCall }
}

describe('CallsController.createStandalone', () => {
  it('rejects a broadcast with zero panelists', async () => {
    const { controller, createStandaloneCall } = makeController()
    await expect(
      controller.createStandalone(makeReq(), {
        call_id: 'call-1', call_type: 'broadcast', invitee_user_ids: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(createStandaloneCall).not.toHaveBeenCalled()
  })

  it('rejects a broadcast with more than 30 panelists', async () => {
    const { controller, createStandaloneCall } = makeController()
    const tooMany = Array.from({ length: 31 }, (_, i) => `panelist-${i}`)
    await expect(
      controller.createStandalone(makeReq(), {
        call_id: 'call-1', call_type: 'broadcast', invitee_user_ids: tooMany,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(createStandaloneCall).not.toHaveBeenCalled()
  })

  it('accepts a broadcast with exactly 30 panelists', async () => {
    const { controller, createStandaloneCall } = makeController()
    const thirty = Array.from({ length: 30 }, (_, i) => `panelist-${i}`)
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'broadcast', invitee_user_ids: thirty,
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ callType: 'broadcast', inviteeUserIds: thirty }),
    )
  })

  it('accepts a broadcast with exactly 1 panelist', async () => {
    const { controller, createStandaloneCall } = makeController()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'broadcast', invitee_user_ids: ['panelist-0'],
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ callType: 'broadcast', inviteeUserIds: ['panelist-0'] }),
    )
  })

  it('never enforces the panelist cap for a non-broadcast call type', async () => {
    const { controller, createStandaloneCall } = makeController()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'video-group', invitee_user_ids: [],
    })
    expect(createStandaloneCall).toHaveBeenCalled()
  })

  it('drops the caller\'s own id from invitee_user_ids before validating/storing', async () => {
    const { controller, createStandaloneCall } = makeController()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'broadcast', invitee_user_ids: ['panelist-0', 'user-1'],
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ inviteeUserIds: ['panelist-0'] }),
    )
  })

  it('stores a clamped duration for a scheduled call', async () => {
    const { controller, createStandaloneCall } = makeController()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'voice', scheduled_for: future, duration_minutes: 10_000,
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledDurationMinutes: 1440 }),
    )
  })

  it('clamps a too-short duration up to the 5 minute minimum', async () => {
    const { controller, createStandaloneCall } = makeController()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'voice', scheduled_for: future, duration_minutes: 1,
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledDurationMinutes: 5 }),
    )
  })

  it('ignores a duration for an instant (non-scheduled) call', async () => {
    const { controller, createStandaloneCall } = makeController()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'voice', duration_minutes: 30,
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledDurationMinutes: null }),
    )
  })

  it('returns scheduledDurationMinutes in the response', async () => {
    const { controller } = makeController({
      createStandaloneCall: jest.fn().mockResolvedValue({
        callId: 'call-1', conversationId: 'standalone:call-1', inviteToken: 'tok-1',
        callType: 'voice', title: 'My call', scheduledFor: new Date(), scheduledDurationMinutes: 45,
        isStandalone: true,
      }),
    })
    const result = await controller.createStandalone(makeReq(), { call_id: 'call-1' })
    expect(result.scheduledDurationMinutes).toBe(45)
  })

  it('passes host_is_panelist through to createStandaloneCall as hostIsPanelist', async () => {
    const { controller, createStandaloneCall } = makeController()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'broadcast', invitee_user_ids: ['panelist-0'], host_is_panelist: false,
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ hostIsPanelist: false }),
    )
  })

  it('leaves hostIsPanelist undefined (service defaults it) when host_is_panelist is not sent', async () => {
    const { controller, createStandaloneCall } = makeController()
    await controller.createStandalone(makeReq(), {
      call_id: 'call-1', call_type: 'broadcast', invitee_user_ids: ['panelist-0'],
    })
    expect(createStandaloneCall).toHaveBeenCalledWith(
      expect.objectContaining({ hostIsPanelist: undefined }),
    )
  })
})
