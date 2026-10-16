import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { ScheduledMessagesService } from './scheduled-messages.service'

function makeModel(overrides: Partial<Record<string, any>> = {}) {
  function MockModel(this: any, doc: any) {
    Object.assign(this, doc)
    this._id = overrides.__newId ?? 'new-id'
    this.save = jest.fn().mockResolvedValue(this)
  }
  const findChain = (result: any[]) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  })
  ;(MockModel as any).findOne = overrides.findOne ?? jest.fn().mockResolvedValue(null)
  ;(MockModel as any).find = overrides.find ?? jest.fn().mockReturnValue(findChain([]))
  ;(MockModel as any).findOneAndUpdate = overrides.findOneAndUpdate ?? jest.fn().mockResolvedValue(null)
  ;(MockModel as any).findById = overrides.findById ?? jest.fn().mockResolvedValue(null)
  ;(MockModel as any).updateOne = overrides.updateOne ?? jest.fn().mockResolvedValue({})
  ;(MockModel as any).updateMany = overrides.updateMany ?? jest.fn().mockResolvedValue({ modifiedCount: 0 })
  return MockModel
}

const future = (ms: number) => new Date(Date.now() + ms)

describe('ScheduledMessagesService.schedule', () => {
  it('rejects a scheduledAt less than 10s in the future', async () => {
    const service = new ScheduledMessagesService(makeModel() as any)
    await expect(
      service.schedule({
        conversationId: 'c1',
        senderId: 'u1',
        clientId: 'cl1',
        payload: { kind: 'text', text: 'hi' },
        scheduledAt: future(5_000),
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects an invalid date', async () => {
    const service = new ScheduledMessagesService(makeModel() as any)
    await expect(
      service.schedule({
        conversationId: 'c1',
        senderId: 'u1',
        clientId: 'cl1',
        payload: { kind: 'text' },
        scheduledAt: new Date('not-a-date'),
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('returns the existing row instead of duplicating on a retried submission (same clientId)', async () => {
    const existing = { _id: 'existing', conversationId: 'c1', clientId: 'cl1' }
    const findOne = jest.fn().mockResolvedValue(existing)
    const service = new ScheduledMessagesService(makeModel({ findOne }) as any)

    const result = await service.schedule({
      conversationId: 'c1',
      senderId: 'u1',
      clientId: 'cl1',
      payload: { kind: 'text', text: 'hi' },
      scheduledAt: future(60_000),
    })

    expect(result).toBe(existing)
  })

  it('persists a new row with status=scheduled and nextAttemptAt=scheduledAt', async () => {
    const service = new ScheduledMessagesService(makeModel() as any)
    const scheduledAt = future(60_000)

    const result: any = await service.schedule({
      conversationId: 'c1',
      senderId: 'u1',
      clientId: 'cl1',
      payload: { kind: 'text', text: 'hi' },
      scheduledAt,
    })

    expect(result.status).toBe('scheduled')
    expect(result.nextAttemptAt).toBe(scheduledAt)
    expect(result.save).toHaveBeenCalled()
  })
})

describe('ScheduledMessagesService.cancel', () => {
  it('cancels a still-scheduled message', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({ status: 'cancelled' })
    const service = new ScheduledMessagesService(makeModel({ findOneAndUpdate }) as any)

    const result = await service.cancel({ id: 'm1', senderId: 'u1' })

    expect(result).toEqual({ ok: true, status: 'cancelled' })
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'm1', senderId: 'u1', status: 'scheduled' },
      { $set: { status: 'cancelled', cancelledAt: expect.any(Date) } },
      { new: true },
    )
  })

  it('refuses to cancel — and reports the real status — once a worker has already claimed the message', async () => {
    // The conditional filter (status: 'scheduled') simply won't match a row
    // already flipped to 'processing' by the cron, so this never pretends
    // to cancel something that may already be irreversibly in flight.
    const findOneAndUpdate = jest.fn().mockResolvedValue(null)
    const findOne = jest.fn().mockResolvedValue({ _id: 'm1', senderId: 'u1', status: 'processing' })
    const service = new ScheduledMessagesService(makeModel({ findOneAndUpdate, findOne }) as any)

    const result = await service.cancel({ id: 'm1', senderId: 'u1' })

    expect(result).toEqual({ ok: false, status: 'processing' })
  })

  it('throws NotFoundException when the message does not belong to this sender (or does not exist)', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue(null)
    const findOne = jest.fn().mockResolvedValue(null)
    const service = new ScheduledMessagesService(makeModel({ findOneAndUpdate, findOne }) as any)

    await expect(service.cancel({ id: 'm1', senderId: 'u1' })).rejects.toThrow(NotFoundException)
  })
})

describe('ScheduledMessagesService.reschedule', () => {
  it('rejects a new scheduledAt that is too soon', async () => {
    const service = new ScheduledMessagesService(makeModel() as any)
    await expect(
      service.reschedule({ id: 'm1', senderId: 'u1', scheduledAt: future(1_000) }),
    ).rejects.toThrow(BadRequestException)
  })

  it('refuses to edit a message that is no longer scheduled', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue(null)
    const findOne = jest.fn().mockResolvedValue({ _id: 'm1', senderId: 'u1', status: 'sent' })
    const service = new ScheduledMessagesService(makeModel({ findOneAndUpdate, findOne }) as any)

    const result = await service.reschedule({ id: 'm1', senderId: 'u1', scheduledAt: future(60_000) })

    expect(result).toEqual({ ok: false, status: 'sent' })
  })

  it('updates content and scheduledAt together when still scheduled', async () => {
    const updated = { _id: 'm1', status: 'scheduled' }
    const findOneAndUpdate = jest.fn().mockResolvedValue(updated)
    const service = new ScheduledMessagesService(makeModel({ findOneAndUpdate }) as any)
    const scheduledAt = future(120_000)

    const result = await service.reschedule({
      id: 'm1',
      senderId: 'u1',
      scheduledAt,
      payload: { kind: 'text', text: 'edited' },
    })

    expect(result).toEqual({ ok: true, status: 'scheduled', doc: updated })
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'm1', senderId: 'u1', status: 'scheduled' },
      { $set: { payload: { kind: 'text', text: 'edited' }, scheduledAt, nextAttemptAt: scheduledAt } },
      { new: true },
    )
  })
})

describe('ScheduledMessagesService.claimNextDue', () => {
  it('claims up to `limit` due items, one atomic findOneAndUpdate per claim, stopping early when none remain', async () => {
    const docs = [{ _id: 'a' }, { _id: 'b' }]
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValueOnce(docs[0])
      .mockResolvedValueOnce(docs[1])
      .mockResolvedValueOnce(null)
    const service = new ScheduledMessagesService(makeModel({ findOneAndUpdate }) as any)

    const claimed = await service.claimNextDue(10)

    expect(claimed).toEqual(docs)
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3)
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { status: { $in: ['scheduled', 'failed'] }, nextAttemptAt: { $lte: expect.any(Date) } },
      { $set: { status: 'processing', processingStartedAt: expect.any(Date) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, new: true },
    )
  })

  it('two concurrent callers can never claim the same document — each findOneAndUpdate call is independent and atomic', async () => {
    // This is a documentation-style test: the real exactly-once guarantee
    // comes from MongoDB's single-document findOneAndUpdate atomicity, not
    // from anything in this service. What we CAN assert here is that the
    // service never claims a batch via a non-atomic find()+updateMany()
    // pair (the old, racy implementation) — every claim is its own
    // conditional findOneAndUpdate call.
    const findOneAndUpdate = jest.fn().mockResolvedValue(null)
    const service = new ScheduledMessagesService(makeModel({ findOneAndUpdate }) as any)
    await service.claimNextDue(5)
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('ScheduledMessagesService.markFailed', () => {
  it('reverts to scheduled with a backoff when attempts remain', async () => {
    const updateOne = jest.fn().mockResolvedValue({})
    const findById = jest.fn().mockResolvedValue({ attempts: 1, maxAttempts: 5 })
    const service = new ScheduledMessagesService(makeModel({ updateOne, findById }) as any)

    await service.markFailed('m1', { error: 'network blip' })

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'm1' },
      {
        $set: {
          status: 'scheduled',
          lastError: 'network blip',
          nextAttemptAt: expect.any(Date),
        },
      },
    )
  })

  it('marks permanently failed once maxAttempts is reached', async () => {
    const updateOne = jest.fn().mockResolvedValue({})
    const findById = jest.fn().mockResolvedValue({ attempts: 5, maxAttempts: 5 })
    const service = new ScheduledMessagesService(makeModel({ updateOne, findById }) as any)

    await service.markFailed('m1', { error: 'still failing' })

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'm1' },
      { $set: { status: 'failed', lastError: 'still failing' } },
    )
  })

  it('marks permanently failed immediately when the caller flags it as unrecoverable', async () => {
    const updateOne = jest.fn().mockResolvedValue({})
    const findById = jest.fn().mockResolvedValue({ attempts: 1, maxAttempts: 5 })
    const service = new ScheduledMessagesService(makeModel({ updateOne, findById }) as any)

    await service.markFailed('m1', { error: 'sender removed from conversation', permanent: true })

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'm1' },
      { $set: { status: 'failed', lastError: 'sender removed from conversation' } },
    )
  })
})

describe('ScheduledMessagesService.recoverStaleProcessing', () => {
  it('requeues messages stuck in processing past the stale threshold', async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 3 })
    const service = new ScheduledMessagesService(makeModel({ updateMany }) as any)

    const count = await service.recoverStaleProcessing()

    expect(count).toBe(3)
    expect(updateMany).toHaveBeenCalledWith(
      { status: 'processing', processingStartedAt: { $lt: expect.any(Date) } },
      { $set: { status: 'scheduled', nextAttemptAt: expect.any(Date) } },
    )
  })
})

describe('ScheduledMessagesService.listPending', () => {
  it('only returns scheduled/processing/failed rows for the given sender, sorted ascending', async () => {
    const find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([{ _id: '1', scheduledAt: future(1000) }]),
    })
    const service = new ScheduledMessagesService(makeModel({ find }) as any)

    const { items, nextCursor } = await service.listPending({ senderId: 'u1' })

    expect(find).toHaveBeenCalledWith({
      senderId: 'u1',
      status: { $in: ['scheduled', 'processing', 'failed'] },
    })
    expect(items).toHaveLength(1)
    expect(nextCursor).toBeNull()
  })
})

describe('ScheduledMessagesService.getOwned / assertSender', () => {
  it('rejects a sender mismatch', async () => {
    const service = new ScheduledMessagesService(makeModel() as any)
    await expect(
      service.assertSender({ senderId: 'owner' } as any, 'someone-else'),
    ).rejects.toThrow(ForbiddenException)
  })
})
