import { NotFoundException } from '@nestjs/common'
import { MessagesService } from './messages.service'

// Regression coverage for markViewOnceOpened — the server-side half of
// "view-once content disappears, then reappears as the original message."
// This function's own doc comment documents the PRIOR bug it fixed
// (previously implemented via deleteMessage(), which threw ForbiddenException
// for the recipient opening a message they didn't send, silently, since the
// chat.view_once socket handler never checked the ack). This spec exists so
// a regression in that fix — or in the idempotency/field-stripping
// guarantees this function is relied on for by the mobile client's own
// view-once fixes — is caught here rather than only in production.

function makeMessageDoc(overrides: Record<string, any> = {}) {
  const doc: any = {
    _id: 'msg-1',
    conversationId: 'conv-1',
    viewOnce: false,
    viewedAt: undefined,
    text: 'the real secret content',
    attachments: [{ id: 'att-1', url: 'https://cdn.example.com/photo.jpg' }],
    ciphertext: 'base64-ciphertext',
    encryptionMeta: { recipients: [{ userId: 'user-a' }] },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  return doc
}

describe('MessagesService.markViewOnceOpened', () => {
  it('strips every content field, sets viewedAt, and never flips isDeleted', async () => {
    const doc = makeMessageDoc()
    const findOne = jest.fn().mockResolvedValue(doc)
    const service = new MessagesService({ findOne } as any, {} as any, {} as any)

    const result = await service.markViewOnceOpened({
      viewerId: 'user-b',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      nowMs: 1_700_000_000_000,
    })

    expect(findOne).toHaveBeenCalledWith({ _id: 'msg-1', conversationId: 'conv-1' })
    expect(doc.save).toHaveBeenCalledTimes(1)
    expect(result.text).toBeUndefined()
    expect(result.attachments).toBeUndefined()
    expect(result.ciphertext).toBeUndefined()
    expect(result.encryptionMeta).toBeUndefined()
    expect(result.viewOnce).toBe(true)
    expect(result.viewedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(result.isDeleted).not.toBe(true)
  })

  it('is idempotent — a second call (double-tap, retried ack, a second of the viewer\'s own devices) does not re-strip or re-save', async () => {
    const doc = makeMessageDoc({ viewOnce: true, viewedAt: '2026-01-01T00:00:00.000Z', text: undefined, attachments: undefined })
    const findOne = jest.fn().mockResolvedValue(doc)
    const service = new MessagesService({ findOne } as any, {} as any, {} as any)

    const result = await service.markViewOnceOpened({
      viewerId: 'user-b',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    })

    expect(doc.save).not.toHaveBeenCalled()
    expect(result.viewedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('is NOT gated to the sender — any conversation member may open a view-once message they received (the exact case the old deleteMessage()-based implementation threw ForbiddenException on)', async () => {
    const doc = makeMessageDoc({ senderId: 'user-a' })
    const findOne = jest.fn().mockResolvedValue(doc)
    const service = new MessagesService({ findOne } as any, {} as any, {} as any)

    // viewerId ('user-b') is deliberately NOT the sender ('user-a') —
    // authorization here is conversation-membership, asserted by the
    // caller before this is invoked, never sender-only.
    await expect(
      service.markViewOnceOpened({ viewerId: 'user-b', conversationId: 'conv-1', messageId: 'msg-1' }),
    ).resolves.toBeDefined()
    expect(doc.save).toHaveBeenCalledTimes(1)
  })

  it('throws NotFoundException for a message that does not exist in this conversation', async () => {
    const findOne = jest.fn().mockResolvedValue(null)
    const service = new MessagesService({ findOne } as any, {} as any, {} as any)

    await expect(
      service.markViewOnceOpened({ viewerId: 'user-b', conversationId: 'conv-1', messageId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})
