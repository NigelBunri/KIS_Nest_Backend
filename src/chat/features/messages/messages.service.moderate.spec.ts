import { MessagesService } from './messages.service'

describe('MessagesService.moderatorDeleteMessage', () => {
  it('scrubs the exact message content and marks it staff-deleted', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 })
    const service = new MessagesService({ updateOne } as any, {} as any)

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
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 })
    const service = new MessagesService({ updateOne } as any, {} as any)

    const result = await service.moderatorDeleteMessage({ conversationId: 'conv-1', messageId: 'missing' })

    expect(result).toEqual({ found: false })
  })

  it('never touches a message already deleted', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 })
    const service = new MessagesService({ updateOne } as any, {} as any)

    await service.moderatorDeleteMessage({ conversationId: 'conv-1', messageId: 'msg-1' })

    const filterArg = updateOne.mock.calls[0][0]
    expect(filterArg.isDeleted).toEqual({ $ne: true })
  })
})
