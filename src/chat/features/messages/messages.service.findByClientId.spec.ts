import { MessagesService } from './messages.service'

// AND-263: "numbered badge trips, may indicate 2 unread when there's just
// 1 unread". Root cause: the realtime send handler allocated a NEW
// Conversation.last_message_seq (an atomic, PERMANENT increment on the
// Django side) before ever checking whether this clientId had already
// been persisted — a genuine retry (same clientId, e.g. after a socket
// reconnect resent an unacked send) wasted a seq slot that no real message
// ever occupied, permanently inflating every recipient's unread count
// (last_message_seq - last_read_seq) by one per retry. findByClientId lets
// the handler check for an existing message FIRST, so a retry never
// reaches seq allocation at all.

function makeMessageModel(existing: any | null) {
  function MockMessageModel(this: any, doc: any) {
    Object.assign(this, doc)
    this.id = 'new-message-id'
    this.createdAt = new Date('2026-01-01T00:00:00Z')
    this.save = jest.fn().mockResolvedValue(this)
  }
  ;(MockMessageModel as any).findOne = jest.fn().mockResolvedValue(existing)
  return MockMessageModel
}

describe('MessagesService.findByClientId (AND-263)', () => {
  it('returns a normalized {id, seq, createdAt} for an already-persisted message', async () => {
    const existingDoc = {
      id: 'existing-id',
      conversationId: 'conv-1',
      clientId: 'client-1',
      seq: 7,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    const model = makeMessageModel(existingDoc)
    const service = new MessagesService(model as any, {} as any, {} as any)

    const result = await service.findByClientId('conv-1', 'client-1')

    expect(result).toEqual({ id: 'existing-id', seq: 7, createdAt: existingDoc.createdAt })
  })

  it('returns null when no message exists for this clientId yet', async () => {
    const model = makeMessageModel(null)
    const service = new MessagesService(model as any, {} as any, {} as any)

    const result = await service.findByClientId('conv-1', 'client-does-not-exist')

    expect(result).toBeNull()
  })
})

describe('MessagesService.createIdempotent — seq reported on reuse (AND-263)', () => {
  const baseArgs = {
    senderId: 'sender-1',
    conversationId: 'conv-1',
    clientId: 'client-1',
    // Simulates the realtime handler having already allocated a NEW,
    // now-orphaned seq (99) before discovering this is a duplicate -
    // exactly the scenario findByClientId above exists to prevent, kept
    // here as a second line of defense on createIdempotent itself.
    seq: 99,
    input: { kind: 'text', text: 'hi' } as any,
  }

  it('reports the EXISTING message real original seq, not the wastefully-reallocated one, when reused', async () => {
    const existingDoc = {
      id: 'existing-id',
      conversationId: 'conv-1',
      clientId: 'client-1',
      seq: 7,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    const model = makeMessageModel(existingDoc)
    const service = new MessagesService(model as any, {} as any, {} as any)

    const result = await service.createIdempotent(baseArgs)

    expect(result.reused).toBe(true)
    expect(result.seq).toBe(7)
  })

  it('reports the newly-allocated seq for a genuinely new message', async () => {
    const model = makeMessageModel(null)
    const service = new MessagesService(model as any, {} as any, {} as any)

    const result = await service.createIdempotent(baseArgs)

    expect(result.reused).toBe(false)
    expect(result.seq).toBe(99)
  })
})
