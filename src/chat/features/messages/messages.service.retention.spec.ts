import { MessagesService } from './messages.service'

describe('MessagesService.scrubContentForMessagesDeletedBefore', () => {
  it('scrubs content for messages deleted before the cutoff', async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 5 })
    const service = new MessagesService({ updateMany } as any, {} as any)

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
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 })
    const service = new MessagesService({ updateMany } as any, {} as any)

    await service.scrubContentForMessagesDeletedBefore(1_000)

    const filterArg = updateMany.mock.calls[0][0]
    expect(filterArg.text).toBeUndefined()
  })

  it('returns zero when nothing is past the cutoff', async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 })
    const service = new MessagesService({ updateMany } as any, {} as any)

    const result = await service.scrubContentForMessagesDeletedBefore(1_000)

    expect(result).toEqual({ scrubbed: 0 })
  })
})
