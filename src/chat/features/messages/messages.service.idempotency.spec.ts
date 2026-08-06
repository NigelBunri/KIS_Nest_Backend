import { MessagesService } from './messages.service'

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

describe('MessagesService.createIdempotent — reused flag', () => {
  const baseArgs = {
    senderId: 'sender-1',
    conversationId: 'conv-1',
    clientId: 'client-1',
    seq: 1,
    input: { kind: 'text', text: 'hi' } as any,
  }

  it('reports reused=true when the clientId was already persisted', async () => {
    // Regression test: a client that resends EVT.SEND after a socket
    // reconnect (never received the original ack) must not cause the
    // realtime handler to re-run post-send side effects like
    // notifyNewMessage — createIdempotentLegacy correctly returns the
    // existing document without a duplicate insert, but callers previously
    // had no way to know that and always fired the side effects anyway.
    const existingDoc = { id: 'existing-id', conversationId: 'conv-1', clientId: 'client-1', createdAt: new Date() }
    const model = makeMessageModel(existingDoc)
    const service = new MessagesService(model as any, {} as any)

    const result = await service.createIdempotent(baseArgs)

    expect(result.reused).toBe(true)
    expect(result.id).toBe('existing-id')
  })

  it('reports reused=false for a genuinely new message', async () => {
    const model = makeMessageModel(null)
    const service = new MessagesService(model as any, {} as any)

    const result = await service.createIdempotent(baseArgs)

    expect(result.reused).toBe(false)
    expect(result.id).toBe('new-message-id')
  })
})
