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
})
