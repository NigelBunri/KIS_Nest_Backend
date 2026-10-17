import { MessagesService } from './messages.service'

// moderatorDeleteMessage now does a findOne().lean().exec() pass (to
// capture attachment keys for storage.deleteFile) BEFORE updateOne - see
// the identical note in messages.service.retention.spec.ts for why these
// mocks previously lacked it entirely.
const makeLeanExec = (result: unknown) => ({
  lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(result) }),
})

describe('MessagesService.moderatorDeleteMessage', () => {
  it('scrubs the exact message content and marks it staff-deleted', async () => {
    const findOne = jest.fn().mockReturnValue(makeLeanExec(null))
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 })
    const service = new MessagesService({ findOne, updateOne } as any, {} as any, {} as any)

    const result = await service.moderatorDeleteMessage({ conversationId: 'conv-1', messageId: 'msg-1' })

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'msg-1', conversationId: 'conv-1', isDeleted: { $ne: true } },
      expect.objectContaining({
        $set: expect.objectContaining({
          isDeleted: true,
          deleteState: 'deleted_for_everyone',
          deletedBy: 'moderation',
        }),
        $unset: expect.objectContaining({ text: '', ciphertext: '', attachments: '' }),
      }),
    )
    expect(result).toEqual({ found: true })
  })

  it('reports not found when no matching non-deleted message exists', async () => {
    const findOne = jest.fn().mockReturnValue(makeLeanExec(null))
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 })
    const service = new MessagesService({ findOne, updateOne } as any, {} as any, {} as any)

    const result = await service.moderatorDeleteMessage({ conversationId: 'conv-1', messageId: 'missing' })

    expect(result).toEqual({ found: false })
  })

  it('never touches a message already deleted', async () => {
    const findOne = jest.fn().mockReturnValue(makeLeanExec(null))
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 })
    const service = new MessagesService({ findOne, updateOne } as any, {} as any, {} as any)

    await service.moderatorDeleteMessage({ conversationId: 'conv-1', messageId: 'msg-1' })

    const filterArg = updateOne.mock.calls[0][0]
    expect(filterArg.isDeleted).toEqual({ $ne: true })
  })
})
