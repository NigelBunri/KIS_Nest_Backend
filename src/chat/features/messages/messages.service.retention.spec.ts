import { MessagesService } from './messages.service'

// scrubContentForMessagesDeletedBefore now does a find().lean().exec() pass
// (to capture attachment keys for storage.deleteFile, added alongside the
// attachment-storage-purge feature) BEFORE updateMany - these mocks
// previously only stubbed updateMany, so every test here failed with
// "this.messageModel.find is not a function" the instant that find() call
// was added; nobody noticed because this file was never run in isolation
// against the then-current service (it only surfaces when Jest actually
// executes the suite, which a stale mock makes impossible). toPurge is an
// empty array in every test below since none of these cases provide
// attachments to purge - purgeMessageAttachmentStorage's own behavior
// isn't what's under test here.
const makeLeanExec = (result: unknown) => ({
  lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(result) }),
})

describe('MessagesService.scrubContentForMessagesDeletedBefore', () => {
  it('scrubs content for messages deleted before the cutoff', async () => {
    const find = jest.fn().mockReturnValue(makeLeanExec([]))
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 5 })
    const service = new MessagesService({ find, updateMany } as any, {} as any, {} as any)

    const result = await service.scrubContentForMessagesDeletedBefore(1_000)

    expect(updateMany).toHaveBeenCalledWith(
      { isDeleted: true, deletedAt: { $lt: 1_000 } },
      { $unset: expect.objectContaining({ text: '', ciphertext: '', attachments: '', voice: '' }) },
    )
    expect(result).toEqual({ scrubbed: 5 })
  })

  it('does not filter on the presence of a text field', async () => {
    // A voice-only or attachment-only message never had `text` set at
    // all - filtering on its presence would wrongly skip sweeping those
    // messages forever instead of just once, since $unset on an already-
    // absent field is a safe no-op that should just report 0 modified.
    const find = jest.fn().mockReturnValue(makeLeanExec([]))
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 })
    const service = new MessagesService({ find, updateMany } as any, {} as any, {} as any)

    await service.scrubContentForMessagesDeletedBefore(1_000)

    const filterArg = updateMany.mock.calls[0][0]
    expect(filterArg.text).toBeUndefined()
  })

  it('returns zero when nothing is past the cutoff', async () => {
    const find = jest.fn().mockReturnValue(makeLeanExec([]))
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 })
    const service = new MessagesService({ find, updateMany } as any, {} as any, {} as any)

    const result = await service.scrubContentForMessagesDeletedBefore(1_000)

    expect(result).toEqual({ scrubbed: 0 })
  })
})
