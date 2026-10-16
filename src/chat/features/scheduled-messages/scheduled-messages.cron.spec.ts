import { ScheduledMessagesCron } from './scheduled-messages.cron'

function makeServer() {
  const emitted: any[] = []
  return {
    emitted,
    to: jest.fn().mockReturnValue({ emit: (event: string, payload: any) => emitted.push({ event, payload }) }),
    in: jest.fn().mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([]) }),
  }
}

function makeDeps() {
  const scheduledMessagesService = {
    recoverStaleProcessing: jest.fn().mockResolvedValue(0),
    claimNextDue: jest.fn().mockResolvedValue([]),
    markSent: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  }
  const djangoConversationClient: any = {
    assertMember: jest.fn().mockResolvedValue({ isMember: true, isBlocked: false, canSend: true }),
    updateLastMessage: jest.fn().mockResolvedValue(undefined),
    dispatchWebhook: jest.fn().mockResolvedValue(undefined),
    listMemberIds: jest.fn().mockResolvedValue([]),
  }
  const djangoSeqClient = { allocateSeq: jest.fn().mockResolvedValue(42) }
  const messagesService = {
    createIdempotent: jest.fn().mockResolvedValue({
      id: 'msg-1',
      seq: 42,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      dto: { id: 'msg-1', text: 'hi' },
      reused: false,
    }),
  }
  const moderationService = { assertAllowed: jest.fn().mockResolvedValue(undefined) }
  const notificationsService = { notifyNewMessage: jest.fn().mockResolvedValue(undefined) }
  return { scheduledMessagesService, djangoConversationClient, djangoSeqClient, messagesService, moderationService, notificationsService }
}

function makeItem(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: 'sched-1',
    conversationId: 'conv-1',
    senderId: 'user-1',
    senderDeviceId: 'device-1',
    senderName: 'Alice',
    clientId: 'client-1',
    payload: { kind: 'text', text: 'hello later' },
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  } as any
}

describe('ScheduledMessagesCron.deliverOne (via deliverDueMessages)', () => {
  it('does nothing until setServer() has been called', async () => {
    const deps = makeDeps()
    const cron = new ScheduledMessagesCron(
      deps.scheduledMessagesService as any,
      deps.djangoConversationClient,
      deps.djangoSeqClient as any,
      deps.messagesService as any,
      deps.moderationService as any,
      deps.notificationsService as any,
    )
    await cron.deliverDueMessages()
    expect(deps.scheduledMessagesService.claimNextDue).not.toHaveBeenCalled()
  })

  it('delivers a due message through the real send pipeline, broadcasts it, and marks it sent', async () => {
    const deps = makeDeps()
    const item = makeItem()
    deps.scheduledMessagesService.claimNextDue.mockResolvedValue([item])
    const cron = new ScheduledMessagesCron(
      deps.scheduledMessagesService as any,
      deps.djangoConversationClient,
      deps.djangoSeqClient as any,
      deps.messagesService as any,
      deps.moderationService as any,
      deps.notificationsService as any,
    )
    const server = makeServer()
    cron.setServer(server as any)

    await cron.deliverDueMessages()

    // Re-verified authorization at delivery time, not just at schedule time.
    expect(deps.djangoConversationClient.assertMember).toHaveBeenCalledWith(
      { userId: 'user-1', deviceId: 'device-1' },
      'conv-1',
    )
    expect(deps.moderationService.assertAllowed).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      action: 'send',
    })
    // Real pipeline: Django seq allocation + MessagesService.createIdempotent,
    // using the scheduled message's own clientId so a delivery retry could
    // never create a second real Message.
    expect(deps.djangoSeqClient.allocateSeq).toHaveBeenCalledWith('conv-1')
    expect(deps.messagesService.createIdempotent).toHaveBeenCalledWith({
      senderId: 'user-1',
      senderDeviceId: 'device-1',
      conversationId: 'conv-1',
      clientId: 'client-1',
      seq: 42,
      input: item.payload,
    })
    // Broadcast to the conversation room.
    expect(server.to).toHaveBeenCalledWith('conv:conv-1')
    expect(deps.scheduledMessagesService.markSent).toHaveBeenCalledWith('sched-1', {
      sentMessageId: 'msg-1',
      sentSeq: 42,
    })
    expect(deps.scheduledMessagesService.markFailed).not.toHaveBeenCalled()
  })

  it('never re-runs push/webhook side effects when createIdempotent reports reused=true', async () => {
    const deps = makeDeps()
    deps.messagesService.createIdempotent.mockResolvedValue({
      id: 'msg-1',
      seq: 42,
      createdAt: new Date(),
      dto: { id: 'msg-1' },
      reused: true,
    })
    const item = makeItem()
    deps.scheduledMessagesService.claimNextDue.mockResolvedValue([item])
    const cron = new ScheduledMessagesCron(
      deps.scheduledMessagesService as any,
      deps.djangoConversationClient,
      deps.djangoSeqClient as any,
      deps.messagesService as any,
      deps.moderationService as any,
      deps.notificationsService as any,
    )
    const server = makeServer()
    cron.setServer(server as any)

    await cron.deliverDueMessages()

    expect(deps.djangoConversationClient.updateLastMessage).not.toHaveBeenCalled()
    expect(deps.scheduledMessagesService.markSent).toHaveBeenCalled()
  })

  it('marks the item failed-for-retry (not permanently) when the sender lost membership, without ever calling createIdempotent', async () => {
    const deps = makeDeps()
    deps.djangoConversationClient.assertMember.mockResolvedValue({ isMember: false })
    const item = makeItem({ attempts: 1, maxAttempts: 5 })
    deps.scheduledMessagesService.claimNextDue.mockResolvedValue([item])
    const cron = new ScheduledMessagesCron(
      deps.scheduledMessagesService as any,
      deps.djangoConversationClient,
      deps.djangoSeqClient as any,
      deps.messagesService as any,
      deps.moderationService as any,
      deps.notificationsService as any,
    )
    const server = makeServer()
    cron.setServer(server as any)

    await cron.deliverDueMessages()

    expect(deps.messagesService.createIdempotent).not.toHaveBeenCalled()
    expect(deps.scheduledMessagesService.markSent).not.toHaveBeenCalled()
    expect(deps.scheduledMessagesService.markFailed).toHaveBeenCalledWith('sched-1', {
      error: 'Sender is no longer allowed to send in this conversation',
      permanent: false,
    })
  })

  it('marks the item permanently failed once attempts has reached maxAttempts', async () => {
    const deps = makeDeps()
    deps.djangoConversationClient.assertMember.mockRejectedValue(new Error('Django unreachable'))
    const item = makeItem({ attempts: 5, maxAttempts: 5 })
    deps.scheduledMessagesService.claimNextDue.mockResolvedValue([item])
    const cron = new ScheduledMessagesCron(
      deps.scheduledMessagesService as any,
      deps.djangoConversationClient,
      deps.djangoSeqClient as any,
      deps.messagesService as any,
      deps.moderationService as any,
      deps.notificationsService as any,
    )
    const server = makeServer()
    cron.setServer(server as any)

    await cron.deliverDueMessages()

    expect(deps.scheduledMessagesService.markFailed).toHaveBeenCalledWith('sched-1', {
      error: 'Django unreachable',
      permanent: true,
    })
  })

  it('recovers stale processing items on every poll tick, not only at boot', async () => {
    const deps = makeDeps()
    const cron = new ScheduledMessagesCron(
      deps.scheduledMessagesService as any,
      deps.djangoConversationClient,
      deps.djangoSeqClient as any,
      deps.messagesService as any,
      deps.moderationService as any,
      deps.notificationsService as any,
    )
    cron.setServer(makeServer() as any)

    await cron.deliverDueMessages()
    await cron.deliverDueMessages()

    expect(deps.scheduledMessagesService.recoverStaleProcessing).toHaveBeenCalledTimes(2)
  })

  it('recovers stale processing items on boot (onModuleInit)', async () => {
    const deps = makeDeps()
    deps.scheduledMessagesService.recoverStaleProcessing.mockResolvedValue(2)
    const cron = new ScheduledMessagesCron(
      deps.scheduledMessagesService as any,
      deps.djangoConversationClient,
      deps.djangoSeqClient as any,
      deps.messagesService as any,
      deps.moderationService as any,
      deps.notificationsService as any,
    )

    await cron.onModuleInit()

    expect(deps.scheduledMessagesService.recoverStaleProcessing).toHaveBeenCalledTimes(1)
  })
})
