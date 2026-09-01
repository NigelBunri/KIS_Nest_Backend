import { MessagesService } from './messages.service'

describe('MessagesService.purgeMessagesForUser', () => {
  it('scrubs every non-deleted message from the user and returns the distinct conversation ids touched', async () => {
    const distinct = jest.fn().mockResolvedValue(['conv-1', 'conv-2'])
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 7 })
    const service = new MessagesService({ distinct, updateMany } as any, {} as any)

    const result = await service.purgeMessagesForUser('user-1')

    expect(distinct).toHaveBeenCalledWith('conversationId', {
      senderId: 'user-1',
      isDeleted: { $ne: true },
    })
    expect(updateMany).toHaveBeenCalledWith(
      { senderId: 'user-1', isDeleted: { $ne: true } },
      expect.objectContaining({
        $set: expect.objectContaining({
          isDeleted: true,
          deleteState: 'deleted_for_everyone',
          deletedBy: 'user-1',
        }),
        $unset: expect.objectContaining({
          text: '',
          ciphertext: '',
          attachments: '',
        }),
      }),
    )
    expect(result).toEqual({ scrubbed: 7, conversationIds: ['conv-1', 'conv-2'] })
  })

  it('returns zero scrubbed when the user has no messages', async () => {
    const distinct = jest.fn().mockResolvedValue([])
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 })
    const service = new MessagesService({ distinct, updateMany } as any, {} as any)

    const result = await service.purgeMessagesForUser('user-with-no-messages')

    expect(result).toEqual({ scrubbed: 0, conversationIds: [] })
  })

  it('never touches messages already deleted', async () => {
    const distinct = jest.fn().mockResolvedValue([])
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 })
    const service = new MessagesService({ distinct, updateMany } as any, {} as any)

    await service.purgeMessagesForUser('user-1')

    const filterArg = updateMany.mock.calls[0][0]
    expect(filterArg.isDeleted).toEqual({ $ne: true })
  })
})
