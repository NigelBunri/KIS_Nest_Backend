import { CallsService } from './calls.service'

// hasActiveInviteToken is the authoritative gate createCallHandler and
// registerJoinBeforeHostHandlers (calls.ts) use to decide whether a
// non-Django-member can still answer/ICE/end/wait-on a conversation-backed
// call — exactly the "valid invite link" flow CallJoinScreen.tsx resolves
// via GET /calls/join/:token. See calls.invite-link-answer.spec.ts and
// calls.waiting-room.spec.ts for the handler-level regression coverage
// this unblocks.
describe('CallsService.hasActiveInviteToken', () => {
  it('returns true for a call with a live invite token that has not ended', async () => {
    const calls = {
      findOne: jest.fn().mockReturnValue({
        lean: () => Promise.resolve({ inviteToken: 'tok-123', status: 'ringing' }),
      }),
    }
    const service = new CallsService(calls as any)

    const result = await service.hasActiveInviteToken('conv-1', 'call-1')

    expect(calls.findOne).toHaveBeenCalledWith(
      { conversationId: 'conv-1', callId: 'call-1' },
      { inviteToken: 1, status: 1 },
    )
    expect(result).toBe(true)
  })

  it('returns false when the call has never had an invite token generated', async () => {
    const calls = {
      findOne: jest.fn().mockReturnValue({
        lean: () => Promise.resolve({ inviteToken: null, status: 'ringing' }),
      }),
    }
    const service = new CallsService(calls as any)

    expect(await service.hasActiveInviteToken('conv-1', 'call-1')).toBe(false)
  })

  it('returns false once the call has ended, even if it once had a token', async () => {
    const calls = {
      findOne: jest.fn().mockReturnValue({
        lean: () => Promise.resolve({ inviteToken: 'tok-123', status: 'ended' }),
      }),
    }
    const service = new CallsService(calls as any)

    expect(await service.hasActiveInviteToken('conv-1', 'call-1')).toBe(false)
  })

  it('returns false for a missed call', async () => {
    const calls = {
      findOne: jest.fn().mockReturnValue({
        lean: () => Promise.resolve({ inviteToken: 'tok-123', status: 'missed' }),
      }),
    }
    const service = new CallsService(calls as any)

    expect(await service.hasActiveInviteToken('conv-1', 'call-1')).toBe(false)
  })

  it('returns false when the call does not exist', async () => {
    const calls = {
      findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    }
    const service = new CallsService(calls as any)

    expect(await service.hasActiveInviteToken('conv-1', 'call-1')).toBe(false)
  })
})
