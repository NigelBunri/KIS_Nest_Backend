import { CallsService } from './calls.service'

// Regression coverage for the call-lifecycle audit: the stale-call guard in
// createCallOrThrowIfActiveInConversation previously judged staleness by age
// alone, regardless of whether the call was still ringing or had actually
// been answered. A shipped fix briefly shrank the threshold from 5 minutes
// to 60 seconds without adding the status check — meaning any real,
// currently-active call older than a minute (i.e. almost every normal call)
// could be silently ended by a stray/duplicate call.offer. These tests lock
// in the corrected, status-aware behavior.
describe('CallsService — call staleness and state-machine integrity', () => {
  describe('createCallOrThrowIfActiveInConversation', () => {
    it('auto-misses a stale RINGING call and lets a new offer through', async () => {
      const staleRinging = {
        conversationId: 'conv-1',
        callId: 'old-call',
        status: 'ringing',
        startedAt: new Date(Date.now() - 120_000), // 2 min old — past the 90s ring window
      }
      const calls = {
        findOne: jest.fn()
          .mockReturnValueOnce({ lean: () => Promise.resolve(null) }) // existingById: none for the NEW callId
          .mockReturnValueOnce({ lean: () => Promise.resolve(staleRinging) }), // existingActive
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        create: jest.fn().mockResolvedValue({
          toObject: () => ({ conversationId: 'conv-1', callId: 'new-call', status: 'ringing' }),
        }),
      }
      const service = new CallsService(calls as any)

      const result = await service.createCallOrThrowIfActiveInConversation({
        conversationId: 'conv-1',
        callId: 'new-call',
        createdBy: 'caller-1',
      })

      expect((result as any).callId).toBe('new-call')
      // The stale ringing call was flipped to 'missed', not 'ended' —
      // semantically it was never answered.
      expect(calls.updateOne).toHaveBeenCalledWith(
        { conversationId: 'conv-1', callId: 'old-call', status: 'ringing' },
        expect.objectContaining({ $set: expect.objectContaining({ status: 'missed' }) }),
      )
      expect(calls.create).toHaveBeenCalledTimes(1)
    })

    it('NEVER auto-ends an ACTIVE call merely because it is old (1 minute)', async () => {
      const activeCall = {
        conversationId: 'conv-2',
        callId: 'active-call',
        status: 'active',
        startedAt: new Date(Date.now() - 65_000), // just past the old 60s threshold
      }
      const calls = {
        findOne: jest.fn()
          .mockReturnValueOnce({ lean: () => Promise.resolve(null) })
          .mockReturnValueOnce({ lean: () => Promise.resolve(activeCall) }),
        updateOne: jest.fn(),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      await expect(
        service.createCallOrThrowIfActiveInConversation({
          conversationId: 'conv-2',
          callId: 'new-call-2',
          createdBy: 'caller-1',
        }),
      ).rejects.toThrow('CALL_ALREADY_ACTIVE')

      expect(calls.updateOne).not.toHaveBeenCalled()
      expect(calls.create).not.toHaveBeenCalled()
    })

    it('NEVER auto-ends an ACTIVE call merely because it is old (10 minutes)', async () => {
      const activeCall = {
        conversationId: 'conv-3',
        callId: 'active-call',
        status: 'active',
        startedAt: new Date(Date.now() - 10 * 60_000),
      }
      const calls = {
        findOne: jest.fn()
          .mockReturnValueOnce({ lean: () => Promise.resolve(null) })
          .mockReturnValueOnce({ lean: () => Promise.resolve(activeCall) }),
        updateOne: jest.fn(),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      await expect(
        service.createCallOrThrowIfActiveInConversation({
          conversationId: 'conv-3',
          callId: 'new-call-3',
          createdBy: 'caller-1',
        }),
      ).rejects.toThrow('CALL_ALREADY_ACTIVE')
      expect(calls.updateOne).not.toHaveBeenCalled()
    })

    it('NEVER auto-ends an ACTIVE call merely because it is old (2 hours)', async () => {
      const activeCall = {
        conversationId: 'conv-4',
        callId: 'active-call',
        status: 'active',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
      }
      const calls = {
        findOne: jest.fn()
          .mockReturnValueOnce({ lean: () => Promise.resolve(null) })
          .mockReturnValueOnce({ lean: () => Promise.resolve(activeCall) }),
        updateOne: jest.fn(),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      await expect(
        service.createCallOrThrowIfActiveInConversation({
          conversationId: 'conv-4',
          callId: 'new-call-4',
          createdBy: 'caller-1',
        }),
      ).rejects.toThrow('CALL_ALREADY_ACTIVE')
      expect(calls.updateOne).not.toHaveBeenCalled()
    })

    it('falls back to CALL_ALREADY_ACTIVE if the ringing call is answered in the race window', async () => {
      // The stale-ringing update is atomic and guarded by status:'ringing' —
      // if another request answered it between our read and this write,
      // modifiedCount is 0 and we must not proceed to create a second call.
      const staleRinging = {
        conversationId: 'conv-5',
        callId: 'old-call',
        status: 'ringing',
        startedAt: new Date(Date.now() - 120_000),
      }
      const calls = {
        findOne: jest.fn()
          .mockReturnValueOnce({ lean: () => Promise.resolve(null) })
          .mockReturnValueOnce({ lean: () => Promise.resolve(staleRinging) }),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      await expect(
        service.createCallOrThrowIfActiveInConversation({
          conversationId: 'conv-5',
          callId: 'new-call-5',
          createdBy: 'caller-1',
        }),
      ).rejects.toThrow('CALL_ALREADY_ACTIVE')
      expect(calls.create).not.toHaveBeenCalled()
    })

    it('a RINGING call under the 90s window is still CALL_ALREADY_ACTIVE, not stale', async () => {
      const freshRinging = {
        conversationId: 'conv-6',
        callId: 'old-call',
        status: 'ringing',
        startedAt: new Date(Date.now() - 5_000),
      }
      const calls = {
        findOne: jest.fn()
          .mockReturnValueOnce({ lean: () => Promise.resolve(null) })
          .mockReturnValueOnce({ lean: () => Promise.resolve(freshRinging) }),
        updateOne: jest.fn(),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      await expect(
        service.createCallOrThrowIfActiveInConversation({
          conversationId: 'conv-6',
          callId: 'new-call-6',
          createdBy: 'caller-1',
        }),
      ).rejects.toThrow('CALL_ALREADY_ACTIVE')
      expect(calls.updateOne).not.toHaveBeenCalled()
    })

    it('rejects a duplicate/stale call.offer for a callId that already ENDED — does not resurrect it', async () => {
      const endedCall = {
        conversationId: 'conv-7',
        callId: 'call-7',
        status: 'ended',
      }
      const calls = {
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(endedCall) }),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      await expect(
        service.createCallOrThrowIfActiveInConversation({
          conversationId: 'conv-7',
          callId: 'call-7',
          createdBy: 'caller-1',
        }),
      ).rejects.toThrow('CALL_ALREADY_ENDED')
      expect(calls.create).not.toHaveBeenCalled()
    })

    it('rejects a duplicate/stale call.offer for a callId that was MISSED — does not resurrect it', async () => {
      const missedCall = {
        conversationId: 'conv-8',
        callId: 'call-8',
        status: 'missed',
      }
      const calls = {
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(missedCall) }),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      await expect(
        service.createCallOrThrowIfActiveInConversation({
          conversationId: 'conv-8',
          callId: 'call-8',
          createdBy: 'caller-1',
        }),
      ).rejects.toThrow('CALL_ALREADY_ENDED')
    })
  })

  describe('markActive — stale-answer protection', () => {
    it('activates a still-RINGING call (normal first answer)', async () => {
      const calls = {
        findOneAndUpdate: jest.fn().mockReturnValue({
          lean: () => Promise.resolve({ callId: 'c1', status: 'active' }),
        }),
      }
      const service = new CallsService(calls as any)
      const result = await service.markActive('conv-1', 'c1')
      expect(result).toEqual({ callId: 'c1', status: 'active' })
      expect(calls.findOneAndUpdate).toHaveBeenCalledWith(
        { conversationId: 'conv-1', callId: 'c1', status: { $in: ['ringing', 'active'] } },
        { $set: { status: 'active' } },
        { new: true },
      )
    })

    it('allows a later participant to join an already-ACTIVE group call', async () => {
      const calls = {
        findOneAndUpdate: jest.fn().mockReturnValue({
          lean: () => Promise.resolve({ callId: 'c2', status: 'active' }),
        }),
      }
      const service = new CallsService(calls as any)
      const result = await service.markActive('conv-2', 'c2')
      expect(result).not.toBeNull()
    })

    it('returns null for a call that already ENDED (stale answer) — caller must reject it', async () => {
      const calls = {
        findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
      }
      const service = new CallsService(calls as any)
      const result = await service.markActive('conv-3', 'c3')
      expect(result).toBeNull()
    })

    it('returns null for a call that was MISSED (stale answer) — caller must reject it', async () => {
      const calls = {
        findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
      }
      const service = new CallsService(calls as any)
      const result = await service.markActive('conv-4', 'c4')
      expect(result).toBeNull()
    })
  })

  describe('cleanupStaleCalls — participant-aware active-call reaping still works', () => {
    it('only ends an active call once nobody is left joined/connecting', async () => {
      const abandonedActive = {
        conversationId: 'conv-9',
        callId: 'call-9',
        status: 'active',
        startedAt: new Date(Date.now() - 200_000),
        participants: [{ userId: 'u1', status: 'left' }, { userId: 'u2', status: 'left' }],
      }
      const find = jest.fn()
        .mockReturnValueOnce({ lean: () => Promise.resolve([]) })    // stale ringing
        .mockReturnValueOnce({ lean: () => Promise.resolve([abandonedActive]) }) // stale active
        .mockReturnValueOnce({ lean: () => Promise.resolve([]) })    // > 24h active
        .mockReturnValueOnce({ lean: () => Promise.resolve([]) })    // stale pending
      const calls = { find, updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }
      const service = new CallsService(calls as any)

      await service.cleanupStaleCalls()

      expect(calls.updateOne).toHaveBeenCalledWith(
        { conversationId: 'conv-9', callId: 'call-9' },
        expect.objectContaining({ $set: expect.objectContaining({ status: 'ended' }) }),
      )
    })

    it('does NOT end an active call if a participant is still joined/connecting', async () => {
      const stillGoing = {
        conversationId: 'conv-10',
        callId: 'call-10',
        status: 'active',
        startedAt: new Date(Date.now() - 200_000),
        participants: [{ userId: 'u1', status: 'joined' }, { userId: 'u2', status: 'left' }],
      }
      const find = jest.fn()
        .mockReturnValueOnce({ lean: () => Promise.resolve([]) })
        .mockReturnValueOnce({ lean: () => Promise.resolve([stillGoing]) })
        .mockReturnValueOnce({ lean: () => Promise.resolve([]) })
        .mockReturnValueOnce({ lean: () => Promise.resolve([]) })
      const calls = { find, updateOne: jest.fn() }
      const service = new CallsService(calls as any)

      await service.cleanupStaleCalls()

      expect(calls.updateOne).not.toHaveBeenCalled()
    })
  })
})
