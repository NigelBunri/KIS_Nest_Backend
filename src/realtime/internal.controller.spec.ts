import { RealtimeInternalController } from './internal.controller'

function makeGateway() {
  const emit = jest.fn()
  const to = jest.fn(() => ({ emit }))
  return { gateway: { server: { to } } as any, to, emit }
}

describe('RealtimeInternalController.handlePartnerEvent', () => {
  it('fans out the event to each user room', () => {
    const { gateway, to, emit } = makeGateway()
    const controller = new RealtimeInternalController(gateway, {} as any)

    const result = controller.handlePartnerEvent('partner-1', {
      event: 'partner.member_kicked',
      userIds: ['user-1', 'user-2'],
      data: { targetUserId: 'user-3' },
    })

    expect(result).toEqual({ ok: true, emitted: 2 })
    expect(to).toHaveBeenCalledWith('user:user-1')
    expect(to).toHaveBeenCalledWith('user:user-2')
    expect(emit).toHaveBeenCalledWith(
      'partner.member_kicked',
      expect.objectContaining({ partnerId: 'partner-1', userId: 'user-1', data: { targetUserId: 'user-3' } }),
    )
  })

  it('dedupes duplicate user ids', () => {
    const { gateway, to } = makeGateway()
    const controller = new RealtimeInternalController(gateway, {} as any)

    const result = controller.handlePartnerEvent('partner-1', {
      event: 'partner.role_updated',
      userIds: ['user-1', 'user-1', ' user-1 '],
    })

    expect(result).toEqual({ ok: true, emitted: 1 })
    expect(to).toHaveBeenCalledTimes(1)
  })

  it('returns ok:false when event or userIds is missing', () => {
    const { gateway } = makeGateway()
    const controller = new RealtimeInternalController(gateway, {} as any)

    expect(controller.handlePartnerEvent('partner-1', { userIds: ['user-1'] })).toEqual({ ok: false })
    expect(controller.handlePartnerEvent('partner-1', { event: 'partner.role_updated', userIds: [] })).toEqual({ ok: false })
  })

  it('does not throw when the gateway server is unavailable', () => {
    const controller = new RealtimeInternalController({ server: null } as any, {} as any)

    const result = controller.handlePartnerEvent('partner-1', {
      event: 'partner.role_updated',
      userIds: ['user-1'],
    })

    expect(result).toEqual({ ok: true, emitted: 1 })
  })
})
