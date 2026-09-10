import { BadRequestException } from '@nestjs/common'
import { MessagesService } from './messages.service'

// Regression coverage for the 'bible_game_stats' MessageKind added alongside
// the Bible-games share-to-chat feature - a client reported "Kind must be
// one of the following values: ..." because this kind only ever existed on
// the frontend's MessageKind union, never in chat.types.ts's canonical
// MessageKind enum this service (and the socket DTO's IsIn(MESSAGE_KINDS))
// validate against.

function buildMessageModelMock(save = jest.fn().mockResolvedValue(undefined)) {
  const findOne = jest.fn().mockResolvedValue(null)
  const MessageModelMock: any = jest.fn().mockImplementation((doc: any) => ({ ...doc, save }))
  MessageModelMock.findOne = findOne
  return { MessageModelMock, findOne, save }
}

describe('MessagesService bible_game_stats kind', () => {
  it('persists a game-scope bibleGameStats payload', async () => {
    const { MessageModelMock, save } = buildMessageModelMock()
    const service = new MessagesService(MessageModelMock, {} as any)

    await service.createIdempotentLegacy({
      senderId: 'user-1',
      seq: 1,
      input: {
        conversationId: 'conv-1',
        clientId: 'client-1',
        kind: 'bible_game_stats' as any,
        bibleGameStats: {
          scope: 'game',
          gameKey: 'sequence-chain',
          gameTitle: 'Sequence Chain',
          stagesCompleted: 3,
          totalStages: 10,
          verseCount: 1042,
          bestScore: 5,
        },
      } as any,
    })

    expect(save).toHaveBeenCalled()
    const savedDoc = MessageModelMock.mock.calls[0][0]
    expect(savedDoc.kind).toBe('bible_game_stats')
    expect(savedDoc.bibleGameStats).toEqual(
      expect.objectContaining({ scope: 'game', gameKey: 'sequence-chain', stagesCompleted: 3 }),
    )
  })

  it('persists a general-scope bibleGameStats payload', async () => {
    const { MessageModelMock, save } = buildMessageModelMock()
    const service = new MessagesService(MessageModelMock, {} as any)

    await service.createIdempotentLegacy({
      senderId: 'user-1',
      seq: 1,
      input: {
        conversationId: 'conv-1',
        clientId: 'client-2',
        kind: 'bible_game_stats' as any,
        bibleGameStats: {
          scope: 'general',
          totalBibleVerses: 31102,
          versesCovered: 4200,
          gamesCompleted: 3,
          totalGames: 30,
          timesCompletedBible: 0,
        },
      } as any,
    })

    expect(save).toHaveBeenCalled()
  })

  it('rejects bible_game_stats kind with no bibleGameStats payload', async () => {
    const { MessageModelMock } = buildMessageModelMock()
    const service = new MessagesService(MessageModelMock, {} as any)

    await expect(
      service.createIdempotentLegacy({
        senderId: 'user-1',
        seq: 1,
        input: { conversationId: 'conv-1', clientId: 'client-3', kind: 'bible_game_stats' as any } as any,
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects a bibleGameStats payload attached to an unrelated kind', async () => {
    const { MessageModelMock } = buildMessageModelMock()
    const service = new MessagesService(MessageModelMock, {} as any)

    await expect(
      service.createIdempotentLegacy({
        senderId: 'user-1',
        seq: 1,
        input: {
          conversationId: 'conv-1',
          clientId: 'client-4',
          kind: 'text' as any,
          text: 'hello',
          bibleGameStats: { scope: 'general' },
        } as any,
      }),
    ).rejects.toThrow(BadRequestException)
  })
})
