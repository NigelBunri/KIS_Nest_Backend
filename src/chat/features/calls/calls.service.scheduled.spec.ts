import { CallsService } from './calls.service'

// Regression coverage for the "schedule a future call" feature's real root
// cause: getScheduledCalls() filtered status: 'ringing', but a freshly
// created future call is persisted with status: 'pending' (see
// createStandaloneCall) and only becomes 'ringing' once startScheduledCall()
// actually starts it — so the upcoming-calls list was permanently empty.
// Also covers the three new host-only lifecycle actions on a scheduled call:
// start / cancel / reschedule, all of which must be scoped to the real
// creator and to a call still in 'pending' status.

describe('CallsService — scheduled calls', () => {
  describe('getScheduledCalls', () => {
    it('queries by status "pending", not "ringing"', async () => {
      const find = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      })
      const service = new CallsService({ find } as any)

      await service.getScheduledCalls('user-1')

      const filterArg = find.mock.calls[0][0]
      expect(filterArg.status).toBe('pending')
      expect(filterArg.scheduledFor).toEqual({ $gt: expect.any(Date) })
      expect(filterArg.$or).toEqual([{ createdBy: 'user-1' }, { 'participants.userId': 'user-1' }])
    })
  })

  describe('startScheduledCall', () => {
    it('atomically transitions pending → ringing, scoped to the real creator', async () => {
      const findOneAndUpdate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ callId: 'call-1', status: 'ringing' }) })
      const service = new CallsService({ findOneAndUpdate } as any)

      const result = await service.startScheduledCall('standalone:call-1', 'call-1', 'host-1')

      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { conversationId: 'standalone:call-1', callId: 'call-1', createdBy: 'host-1', status: 'pending' },
        { $set: expect.objectContaining({ status: 'ringing', isActiveInConversation: true }) },
        { new: true },
      )
      expect(result).toEqual({ callId: 'call-1', status: 'ringing' })
    })

    it('returns null (and the host gets a FORBIDDEN-shaped failure upstream) when not the creator or already started', async () => {
      const findOneAndUpdate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) })
      const service = new CallsService({ findOneAndUpdate } as any)

      const result = await service.startScheduledCall('standalone:call-1', 'call-1', 'not-the-host')

      expect(result).toBeNull()
    })
  })

  describe('cancelScheduledCall', () => {
    it('ends a still-pending call owned by the caller', async () => {
      const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 })
      const service = new CallsService({ updateOne } as any)

      const result = await service.cancelScheduledCall('standalone:call-1', 'call-1', 'host-1')

      expect(updateOne).toHaveBeenCalledWith(
        { conversationId: 'standalone:call-1', callId: 'call-1', createdBy: 'host-1', status: 'pending' },
        { $set: expect.objectContaining({ status: 'ended', isActiveInConversation: false }) },
      )
      expect(result).toBe(true)
    })

    it('never cancels a call that already started (modifiedCount 0)', async () => {
      const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 0 })
      const service = new CallsService({ updateOne } as any)

      const result = await service.cancelScheduledCall('standalone:call-1', 'call-1', 'host-1')

      expect(result).toBe(false)
    })
  })

  describe('rescheduleCall', () => {
    it('updates scheduledFor on a still-pending call owned by the caller', async () => {
      const newTime = new Date(Date.now() + 3_600_000)
      const findOneAndUpdate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ scheduledFor: newTime }) })
      const service = new CallsService({ findOneAndUpdate } as any)

      const result = await service.rescheduleCall('standalone:call-1', 'call-1', 'host-1', newTime)

      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { conversationId: 'standalone:call-1', callId: 'call-1', createdBy: 'host-1', status: 'pending' },
        { $set: { scheduledFor: newTime } },
        { new: true },
      )
      expect(result).toEqual({ scheduledFor: newTime })
    })
  })
})
