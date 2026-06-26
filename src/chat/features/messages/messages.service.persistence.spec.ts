import { MessagesService } from './messages.service'

describe('MessagesService durable history pagination', () => {
  it('caps one history page at 500 and returns stable string ids in ascending order', async () => {
    const rows = [
      { _id: { toString: () => 'newer' }, createdAt: new Date('2026-01-02T00:00:00Z') },
      { _id: { toString: () => 'older' }, createdAt: new Date('2026-01-01T00:00:00Z') },
    ]
    const exec = jest.fn().mockResolvedValue(rows)
    const lean = jest.fn(() => ({ exec }))
    const limit = jest.fn(() => ({ lean }))
    const sort = jest.fn(() => ({ limit }))
    const find = jest.fn(() => ({ sort }))
    const service = new MessagesService({ find } as any)

    const result = await service.listRecent({
      conversationId: 'conversation-1',
      limit: 5_000,
    })

    expect(find).toHaveBeenCalledWith({ conversationId: 'conversation-1' })
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 })
    expect(limit).toHaveBeenCalledWith(500)
    expect(result.map((message) => message.id)).toEqual(['older', 'newer'])
  })
})
