import { CallsService } from './calls.service'

describe('CallsService — duplicate push notification protection', () => {
  describe('createCallOrThrowIfActiveInConversation', () => {
    it('marks the result __reused when a call.offer is retried for a callId that already exists', async () => {
      const existingCall = {
        conversationId: 'conv-1',
        callId: 'call-1',
        createdBy: 'caller-1',
        status: 'ringing',
      }
      const calls = {
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(existingCall) }),
        create: jest.fn(),
      }
      const service = new CallsService(calls as any)

      const result = await service.createCallOrThrowIfActiveInConversation({
        conversationId: 'conv-1',
        callId: 'call-1',
        createdBy: 'caller-1',
      })

      expect((result as any).__reused).toBe(true)
      expect(calls.create).not.toHaveBeenCalled()
    })

    it('does not mark __reused when creating a genuinely new call', async () => {
      const calls = {
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
        create: jest.fn().mockResolvedValue({
          toObject: () => ({ conversationId: 'conv-2', callId: 'call-2', status: 'ringing' }),
        }),
      }
      const service = new CallsService(calls as any)

      const result = await service.createCallOrThrowIfActiveInConversation({
        conversationId: 'conv-2',
        callId: 'call-2',
        createdBy: 'caller-1',
      })

      expect((result as any).__reused).toBeUndefined()
      expect(calls.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('cleanupStaleCalls — missed-call notification', () => {
    const staleCall = {
      conversationId: 'conv-3',
      callId: 'call-3',
      createdBy: 'caller-1',
      callType: 'voice',
      startedAt: new Date(Date.now() - 100_000),
      participants: [{ userId: 'invitee-1', status: 'invited' }],
    }

    const mockFindChain = (results: any[][]) => {
      const find = jest.fn()
      for (const rows of results) {
        find.mockReturnValueOnce({ lean: () => Promise.resolve(rows) })
      }
      return find
    }

    it('notifies invitees exactly once when this tick wins the status transition', async () => {
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const calls = {
        find: mockFindChain([[staleCall], [], [], []]),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      }
      const service = new CallsService(calls as any)
      service.setNotificationsService({ notifyMissedCall })

      await service.cleanupStaleCalls()

      expect(notifyMissedCall).toHaveBeenCalledTimes(1)
      expect(notifyMissedCall).toHaveBeenCalledWith(
        expect.objectContaining({ toUserId: 'invitee-1', callId: 'call-3' }),
      )
    })

    it('never notifies the call creator about their own unanswered outgoing call timing out', async () => {
      // Regression test: the creator's own participant row is permanently
      // status 'connecting' from call.offer onward (nothing ever flips it
      // to 'joined' for the caller themselves), which otherwise matches
      // the same invited/connecting filter used to find who missed the
      // call — without excluding createdBy explicitly, a 1:1 call that
      // simply rang out would notify the CALLER that they missed their own
      // outgoing call.
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const callWithCreatorParticipant = {
        ...staleCall,
        participants: [
          { userId: 'caller-1', status: 'connecting' },
          { userId: 'invitee-1', status: 'invited' },
        ],
      }
      const calls = {
        find: mockFindChain([[callWithCreatorParticipant], [], [], []]),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      }
      const service = new CallsService(calls as any)
      service.setNotificationsService({ notifyMissedCall })

      await service.cleanupStaleCalls()

      expect(notifyMissedCall).toHaveBeenCalledTimes(1)
      expect(notifyMissedCall).toHaveBeenCalledWith(
        expect.objectContaining({ toUserId: 'invitee-1' }),
      )
      expect(notifyMissedCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ toUserId: 'caller-1' }),
      )
    })

    it('does not notify when another concurrent tick already flipped the call to missed', async () => {
      // Regression test: cleanupStaleCalls runs on an unguarded 30s
      // setInterval with no overlap protection, so a slow tick (or a second
      // server instance running the same cleanup) can race the query that
      // finds "still ringing" calls against another tick's update. Only the
      // update that actually performs the transition (modifiedCount > 0) may
      // fire the missed-call push — otherwise every racing tick would push.
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const calls = {
        find: mockFindChain([[staleCall], [], [], []]),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      }
      const service = new CallsService(calls as any)
      service.setNotificationsService({ notifyMissedCall })

      await service.cleanupStaleCalls()

      expect(notifyMissedCall).not.toHaveBeenCalled()
    })
  })

  // Regression coverage for "caller cancels/ends an unanswered call and the
  // recipient never gets notified": endCall() used to only classify a call
  // as 'missed' (and therefore only consider sending a push) when the
  // client's free-text `reason` matched a fixed whitelist. The mobile app's
  // actual cancel-an-unanswered-call button sends reason: 'ended_by_host'
  // (shared with the genuinely-different "host ends a live call" action),
  // which was never in that whitelist, so cancelling a call nobody had
  // answered yet silently produced no missed-call push at all.
  describe('endCall — missed-call notification (caller-cancel / idempotency)', () => {
    const baseCall = {
      conversationId: 'conv-1',
      callId: 'call-1',
      createdBy: 'caller-1',
      createdByDisplayName: 'Caller One',
      createdByPhone: null,
      callType: 'voice',
      status: 'ringing',
      participants: [
        { userId: 'caller-1', status: 'connecting' },
        { userId: 'invitee-1', status: 'invited' },
      ],
    }

    const makeService = (overrides: Record<string, any> = {}) => {
      const calls = {
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(baseCall) }),
        findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => Promise.resolve({ ...baseCall, status: 'missed' }) }),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        ...overrides,
      }
      const service = new CallsService(calls as any)
      return { service, calls }
    }

    it('classifies as missed and notifies the unanswered invitee for ANY reason string, not just a whitelisted one', async () => {
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const { service, calls } = makeService()
      service.setNotificationsService({ notifyMissedCall })

      // This is the exact reason string the mobile app's caller-cancel
      // button sends (endCallForAll in SocketProvider.tsx) — the whole
      // point of this test is that it is NOT on any whitelist.
      await service.endCall('conv-1', 'call-1', 'caller-1', 'ended_by_host')

      expect(calls.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1', callId: 'call-1', status: 'ringing' }),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'missed' }) }),
        expect.anything(),
      )
      expect(notifyMissedCall).toHaveBeenCalledTimes(1)
      expect(notifyMissedCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toUserId: 'invitee-1',
          fromUserId: 'caller-1',
          fromDisplayName: 'Caller One',
          callId: 'call-1',
        }),
      )
    })

    it('does NOT notify the caller who triggered the end, even though their own participant row is also unanswered-shaped ("connecting")', async () => {
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const { service } = makeService()
      service.setNotificationsService({ notifyMissedCall })

      await service.endCall('conv-1', 'call-1', 'caller-1', 'ended_by_host')

      expect(notifyMissedCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ toUserId: 'caller-1' }),
      )
    })

    it('does NOT send a missed-call notification when the call was actually answered (no false missed push)', async () => {
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const answeredCall = {
        ...baseCall,
        participants: [
          { userId: 'caller-1', status: 'connecting' },
          { userId: 'invitee-1', status: 'joined' },
        ],
      }
      const { service, calls } = makeService({
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(answeredCall) }),
        findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => Promise.resolve({ ...answeredCall, status: 'ended' }) }),
      })
      service.setNotificationsService({ notifyMissedCall })

      await service.endCall('conv-1', 'call-1', 'invitee-1', 'ended_by_host')

      expect(calls.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'ended' }) }),
        expect.anything(),
      )
      expect(notifyMissedCall).not.toHaveBeenCalled()
    })

    it('does not re-notify when the call is already terminal (duplicate/racing call.end)', async () => {
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const alreadyMissed = { ...baseCall, status: 'missed' }
      const { service, calls } = makeService({
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(alreadyMissed) }),
      })
      service.setNotificationsService({ notifyMissedCall })

      await service.endCall('conv-1', 'call-1', 'caller-1', 'ended_by_host')

      expect(calls.findOneAndUpdate).not.toHaveBeenCalled()
      expect(notifyMissedCall).not.toHaveBeenCalled()
    })

    it('does not notify when it loses the CAS race to a concurrent writer (e.g. the stale-ringing reaper)', async () => {
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const { service, calls } = makeService({
        // Simulates another writer having already moved the status away
        // from the snapshot read — findOneAndUpdate's filter no longer
        // matches, so it returns null.
        findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
      })
      service.setNotificationsService({ notifyMissedCall })

      await service.endCall('conv-1', 'call-1', 'caller-1', 'ended_by_host')

      expect(notifyMissedCall).not.toHaveBeenCalled()
    })

    it('notifies every unanswered invitee in a group call, skipping ones who already joined', async () => {
      const notifyMissedCall = jest.fn().mockResolvedValue(undefined)
      const groupCall = {
        ...baseCall,
        participants: [
          { userId: 'caller-1', status: 'connecting' },
          { userId: 'invitee-1', status: 'invited' },
          { userId: 'invitee-2', status: 'invited' },
          { userId: 'invitee-3', status: 'joined' },
        ],
      }
      const { service } = makeService({
        findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(groupCall) }),
        findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => Promise.resolve({ ...groupCall, status: 'missed' }) }),
      })
      service.setNotificationsService({ notifyMissedCall })

      await service.endCall('conv-1', 'call-1', 'caller-1', 'ended_by_host')

      expect(notifyMissedCall).toHaveBeenCalledTimes(2)
      const notified = notifyMissedCall.mock.calls.map((c: any) => c[0].toUserId).sort()
      expect(notified).toEqual(['invitee-1', 'invitee-2'])
    })
  })
})
