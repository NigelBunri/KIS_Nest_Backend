import { CallsService } from './calls.service'

// Covers scheduleDisconnectGrace/cancelDisconnectGrace in isolation —
// pure in-memory timer bookkeeping, no DB access, so a dummy model is
// enough (same pattern as calls.service.spec.ts's `new CallsService({} as
// any)`). The connection-identity-aware guard that decides WHETHER to call
// scheduleDisconnectGrace at all lives in ChatGateway, not here — see
// chat.gateway.disconnect-grace.spec.ts for that half.

describe('CallsService disconnect-grace timers', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('fires onExpire after the grace period elapses', () => {
    const service = new CallsService({} as any)
    const onExpire = jest.fn()

    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-1', onExpire, 1000)
    expect(onExpire).not.toHaveBeenCalled()

    jest.advanceTimersByTime(999)
    expect(onExpire).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('cancelling before expiry prevents onExpire from ever running (genuine reconnect)', () => {
    const service = new CallsService({} as any)
    const onExpire = jest.fn()

    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-1', onExpire, 1000)
    const cancelled = service.cancelDisconnectGrace('conv-1', 'call-1', 'user-1')

    expect(cancelled).toBe(true)
    jest.advanceTimersByTime(5000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('cancelDisconnectGrace returns false when nothing is pending for that key', () => {
    const service = new CallsService({} as any)
    expect(service.cancelDisconnectGrace('conv-1', 'call-1', 'user-1')).toBe(false)
  })

  it('scheduling twice for the same key replaces the old timer instead of stacking a duplicate (only one onExpire runs)', () => {
    const service = new CallsService({} as any)
    const firstExpire = jest.fn()
    const secondExpire = jest.fn()

    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-1', firstExpire, 1000)
    jest.advanceTimersByTime(500)
    // A second disconnect for the same user/call before the first timer
    // fired — the real-world "duplicate disconnect events" case.
    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-1', secondExpire, 1000)

    jest.advanceTimersByTime(999)
    expect(firstExpire).not.toHaveBeenCalled()
    expect(secondExpire).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(firstExpire).not.toHaveBeenCalled()
    expect(secondExpire).toHaveBeenCalledTimes(1)
  })

  it('timers for different users/calls are independent', () => {
    const service = new CallsService({} as any)
    const expireA = jest.fn()
    const expireB = jest.fn()

    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-A', expireA, 1000)
    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-B', expireB, 2000)
    service.cancelDisconnectGrace('conv-1', 'call-1', 'user-A')

    jest.advanceTimersByTime(2000)
    expect(expireA).not.toHaveBeenCalled()
    expect(expireB).toHaveBeenCalledTimes(1)
  })

  it('a genuine timeout (no reconnect) still ends the call via onExpire', () => {
    const service = new CallsService({} as any)
    const setParticipantLeft = jest.fn()
    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-1', setParticipantLeft, 45_000)

    jest.advanceTimersByTime(45_000)
    expect(setParticipantLeft).toHaveBeenCalledTimes(1)
  })

  it('onModuleDestroy clears every pending timer so none can fire later (no leaked timers/callbacks)', () => {
    const service = new CallsService({} as any)
    const onExpire = jest.fn()
    service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-1', onExpire, 1000)

    service.onModuleDestroy()
    jest.advanceTimersByTime(5000)

    expect(onExpire).not.toHaveBeenCalled()
  })

  it('an onExpire that rejects does not throw synchronously or crash the timer callback', () => {
    const service = new CallsService({} as any)
    const onExpire = jest.fn().mockRejectedValue(new Error('boom'))

    expect(() => {
      service.scheduleDisconnectGrace('conv-1', 'call-1', 'user-1', onExpire, 1000)
      jest.advanceTimersByTime(1000)
    }).not.toThrow()
  })
})
