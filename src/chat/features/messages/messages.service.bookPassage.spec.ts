import { BadRequestException } from '@nestjs/common'
import { MessagesService } from './messages.service'

// Regression coverage for the 'book_passage' MessageKind added alongside the
// KIS Books "controlled passage sharing" feature - mirrors
// messages.service.bibleGameStats.spec.ts's shape for a sub-payload kind:
// valid payload persists, missing payload is rejected, and the payload
// can't be smuggled in under an unrelated kind.

function buildMessageModelMock(save = jest.fn().mockResolvedValue(undefined)) {
  const findOne = jest.fn().mockResolvedValue(null)
  const MessageModelMock: any = jest.fn().mockImplementation((doc: any) => ({ ...doc, save }))
  MessageModelMock.findOne = findOne
  return { MessageModelMock, findOne, save }
}

describe('MessagesService book_passage kind', () => {
  it('persists a bookPassage payload', async () => {
    const { MessageModelMock, save } = buildMessageModelMock()
    const service = new MessagesService(MessageModelMock, {} as any, {} as any)

    await service.createIdempotentLegacy({
      senderId: 'user-1',
      seq: 1,
      input: {
        conversationId: 'conv-1',
        clientId: 'client-1',
        kind: 'book_passage' as any,
        bookPassage: {
          bookId: 'book-1',
          bookTitle: 'The Quiet Hills',
          authorName: 'Eleanor Marsh',
          chapterStableId: 'chapter-1',
          blockId: 'block-1',
          quotedText: 'Grace abounds in every season.',
        },
      } as any,
    })

    expect(save).toHaveBeenCalled()
    const savedDoc = MessageModelMock.mock.calls[0][0]
    expect(savedDoc.kind).toBe('book_passage')
    expect(savedDoc.bookPassage).toEqual(
      expect.objectContaining({ bookId: 'book-1', bookTitle: 'The Quiet Hills', quotedText: 'Grace abounds in every season.' }),
    )
  })

  it('rejects book_passage kind with no bookPassage payload', async () => {
    const { MessageModelMock } = buildMessageModelMock()
    const service = new MessagesService(MessageModelMock, {} as any, {} as any)

    await expect(
      service.createIdempotentLegacy({
        senderId: 'user-1',
        seq: 1,
        input: { conversationId: 'conv-1', clientId: 'client-2', kind: 'book_passage' as any } as any,
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects a bookPassage payload attached to an unrelated kind', async () => {
    const { MessageModelMock } = buildMessageModelMock()
    const service = new MessagesService(MessageModelMock, {} as any, {} as any)

    await expect(
      service.createIdempotentLegacy({
        senderId: 'user-1',
        seq: 1,
        input: {
          conversationId: 'conv-1',
          clientId: 'client-3',
          kind: 'text' as any,
          text: 'hello',
          bookPassage: { bookId: 'book-1', bookTitle: 'X', chapterStableId: 'c1', quotedText: 'q' },
        } as any,
      }),
    ).rejects.toThrow(BadRequestException)
  })
})
