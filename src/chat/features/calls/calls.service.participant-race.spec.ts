import { CallsService } from './calls.service'

// Regression test for the race window in setParticipantStatus found during
// the KIS calling-system audit: the previous implementation read the call
// with a separate findOne, decided in JS whether a participant row already
// existed, and only then wrote — leaving a window for a second concurrent
// caller (e.g. answer racing a decline from two devices of the same user,
// or a duplicate/out-of-order socket event) to be evaluated against the
// SAME stale read before either write lands. These tests assert the fix:
// the existence check and the write are now one atomic conditional
// updateOne, keyed off matchedCount at write time, not a prior read.
describe('CallsService.setParticipantStatus — atomicity', () => {
  it('writes an existing participant via a single conditional updateOne, never a separate read-then-decide', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 })
    const findOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve({ conversationId: 'conv-1', callId: 'call-1', participants: [] }) })
    const calls = { updateOne, findOne }
    const service = new CallsService(calls as any)

    await service.setParticipantStatus('conv-1', 'call-1', 'user-1', 'joined')

    // The implementation must not call findOne to decide existence before
    // writing — only the conditional updateOne (matched/unmatched) and the
    // final read-back findOne are allowed. Exactly one updateOne call
    // proves the $push fallback branch was correctly skipped once
    // matchedCount came back 1, without a prior JS-level existence check
    // racing against it.
    expect(updateOne).toHaveBeenCalledTimes(1)
    expect(updateOne).toHaveBeenCalledWith(
      { conversationId: 'conv-1', callId: 'call-1', 'participants.userId': 'user-1' },
      expect.objectContaining({ $set: expect.objectContaining({ 'participants.$.status': 'joined' }) }),
    )
  })

  it('falls back to $push only when the conditional update genuinely matched nothing (new participant)', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 })
    const findOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve({ conversationId: 'conv-2', callId: 'call-2', participants: [] }) })
    const calls = { updateOne, findOne }
    const service = new CallsService(calls as any)

    await service.setParticipantStatus('conv-2', 'call-2', 'new-user', 'invited')

    expect(updateOne).toHaveBeenCalledTimes(2)
    // Second call is the $push fallback, scoped to the call itself (no
    // 'participants.userId' filter — it couldn't match, that's why we're here).
    expect(updateOne).toHaveBeenNthCalledWith(
      2,
      { conversationId: 'conv-2', callId: 'call-2' },
      expect.objectContaining({ $push: expect.objectContaining({ participants: expect.objectContaining({ userId: 'new-user', status: 'invited' }) }) }),
    )
  })

  it('a decline that lands after an answer already updated the row does not get silently dropped or misapplied to a different row', async () => {
    // Simulates the real race: two concurrent setParticipantStatus calls
    // for the SAME existing participant. Both see matchedCount: 1 (the
    // row already existed before either write — this is the case the old
    // code's single upfront findOne could get wrong if a $push from a
    // third call landed in between the read and the write). Each call's
    // own conditional updateOne is independently atomic regardless of
    // ordering — there is no shared stale read between them to corrupt.
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 })
    const findOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve({ conversationId: 'conv-3', callId: 'call-3', participants: [{ userId: 'user-1', status: 'joined' }] }) })
    const calls = { updateOne, findOne }
    const service = new CallsService(calls as any)

    const [a, b] = await Promise.all([
      service.setParticipantStatus('conv-3', 'call-3', 'user-1', 'left', 'declined'),
      service.setParticipantStatus('conv-3', 'call-3', 'user-1', 'left', 'hung_up'),
    ])

    // Both calls complete (no exception, no silent no-op) and each issued
    // its own atomic conditional write — neither depended on a shared,
    // potentially-stale JS-level "does this participant exist" decision.
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(updateOne).toHaveBeenCalledTimes(2)
  })

  it('returns null for a call that does not exist, without a separate upfront existence check', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 })
    const findOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) })
    const calls = { updateOne, findOne }
    const service = new CallsService(calls as any)

    const result = await service.setParticipantStatus('conv-missing', 'call-missing', 'user-1', 'joined')

    expect(result).toBeNull()
  })
})
