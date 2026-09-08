import { RealtimeInternalController } from './internal.controller'

function makeGateway() {
  const emit = jest.fn()
  const to = jest.fn(() => ({ emit }))
  return { gateway: { server: { to } } as any, to, emit }
}

function makeMessagesService(
  overrides: Partial<{ purgeMessagesForUser: jest.Mock; moderatorDeleteMessage: jest.Mock }> = {},
) {
  return {
    purgeMessagesForUser: jest.fn().mockResolvedValue({ scrubbed: 0, conversationIds: [] }),
    moderatorDeleteMessage: jest.fn().mockResolvedValue({ found: false }),
    ...overrides,
  } as any
}

describe('RealtimeInternalController.handlePartnerEvent', () => {
  it('fans out the event to each user room', () => {
    const { gateway, to, emit } = makeGateway()
    const controller = new RealtimeInternalController(gateway, {} as any, makeMessagesService(), {} as any, {} as any)

    const result = controller.handlePartnerEvent('partner-1', {
      event: 'partner.member_kicked',
      userIds: ['user-1', 'user-2'],
      data: { targetUserId: 'user-3' },
    })

    expect(result).toEqual({ ok: true, emitted: 2 })
    expect(to).toHaveBeenCalledWith('user:user-1')
    expect(to).toHaveBeenCalledWith('user:user-2')
    expect(emit).toHaveBeenCalledWith(
      'partner.member_kicked',
      expect.objectContaining({ partnerId: 'partner-1', userId: 'user-1', data: { targetUserId: 'user-3' } }),
    )
  })

  it('dedupes duplicate user ids', () => {
    const { gateway, to } = makeGateway()
    const controller = new RealtimeInternalController(gateway, {} as any, makeMessagesService(), {} as any, {} as any)

    const result = controller.handlePartnerEvent('partner-1', {
      event: 'partner.role_updated',
      userIds: ['user-1', 'user-1', ' user-1 '],
    })

    expect(result).toEqual({ ok: true, emitted: 1 })
    expect(to).toHaveBeenCalledTimes(1)
  })

  it('returns ok:false when event or userIds is missing', () => {
    const { gateway } = makeGateway()
    const controller = new RealtimeInternalController(gateway, {} as any, makeMessagesService(), {} as any, {} as any)

    expect(controller.handlePartnerEvent('partner-1', { userIds: ['user-1'] })).toEqual({ ok: false })
    expect(controller.handlePartnerEvent('partner-1', { event: 'partner.role_updated', userIds: [] })).toEqual({ ok: false })
  })

  it('does not throw when the gateway server is unavailable', () => {
    const controller = new RealtimeInternalController({ server: null } as any, {} as any, makeMessagesService(), {} as any, {} as any)

    const result = controller.handlePartnerEvent('partner-1', {
      event: 'partner.role_updated',
      userIds: ['user-1'],
    })

    expect(result).toEqual({ ok: true, emitted: 1 })
  })
})

describe('RealtimeInternalController.purgeUserMessages', () => {
  it('scrubs the user\'s messages and notifies every affected conversation room', async () => {
    const { gateway, to, emit } = makeGateway()
    const messagesService = makeMessagesService({
      purgeMessagesForUser: jest.fn().mockResolvedValue({
        scrubbed: 3,
        conversationIds: ['conv-1', 'conv-2'],
      }),
    })
    const controller = new RealtimeInternalController(gateway, {} as any, messagesService, {} as any, {} as any)

    const result = await controller.purgeUserMessages('user-1')

    expect(messagesService.purgeMessagesForUser).toHaveBeenCalledWith('user-1')
    expect(result).toEqual({ ok: true, scrubbed: 3, conversations: 2 })
    expect(to).toHaveBeenCalledWith('conv:conv-1')
    expect(to).toHaveBeenCalledWith('conv:conv-2')
    expect(emit).toHaveBeenCalledWith(
      'messages.purged',
      expect.objectContaining({ senderId: 'user-1', reason: 'account_deletion' }),
    )
  })

  it('rejects a missing userId', async () => {
    const { gateway } = makeGateway()
    const messagesService = makeMessagesService()
    const controller = new RealtimeInternalController(gateway, {} as any, messagesService, {} as any, {} as any)

    await expect(controller.purgeUserMessages('   ')).rejects.toThrow('userId is required.')
    expect(messagesService.purgeMessagesForUser).not.toHaveBeenCalled()
  })

  it('does not throw when a conversation room has no gateway server', async () => {
    const messagesService = makeMessagesService({
      purgeMessagesForUser: jest.fn().mockResolvedValue({
        scrubbed: 1,
        conversationIds: ['conv-1'],
      }),
    })
    const controller = new RealtimeInternalController({ server: null } as any, {} as any, messagesService, {} as any, {} as any)

    const result = await controller.purgeUserMessages('user-1')

    expect(result).toEqual({ ok: true, scrubbed: 1, conversations: 1 })
  })
})

describe('RealtimeInternalController.moderatorDeleteMessage', () => {
  it('deletes the message and notifies the conversation room when found', async () => {
    const { gateway, to, emit } = makeGateway()
    const messagesService = makeMessagesService({
      moderatorDeleteMessage: jest.fn().mockResolvedValue({ found: true }),
    })
    const controller = new RealtimeInternalController(gateway, {} as any, messagesService, {} as any, {} as any)

    const result = await controller.moderatorDeleteMessage('conv-1', 'msg-1')

    expect(messagesService.moderatorDeleteMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'msg-1',
    })
    expect(result).toEqual({ ok: true, found: true })
    expect(to).toHaveBeenCalledWith('conv:conv-1')
    expect(emit).toHaveBeenCalledWith(
      'message.moderated_delete',
      expect.objectContaining({ conversationId: 'conv-1', messageId: 'msg-1' }),
    )
  })

  it('does not emit to the room when the message was not found', async () => {
    const { gateway, to } = makeGateway()
    const messagesService = makeMessagesService({
      moderatorDeleteMessage: jest.fn().mockResolvedValue({ found: false }),
    })
    const controller = new RealtimeInternalController(gateway, {} as any, messagesService, {} as any, {} as any)

    const result = await controller.moderatorDeleteMessage('conv-1', 'missing')

    expect(result).toEqual({ ok: true, found: false })
    expect(to).not.toHaveBeenCalled()
  })

  it('rejects a missing conversationId or messageId', async () => {
    const { gateway } = makeGateway()
    const messagesService = makeMessagesService()
    const controller = new RealtimeInternalController(gateway, {} as any, messagesService, {} as any, {} as any)

    await expect(controller.moderatorDeleteMessage('', 'msg-1')).rejects.toThrow(
      'conversationId and messageId are required.',
    )
    await expect(controller.moderatorDeleteMessage('conv-1', '')).rejects.toThrow(
      'conversationId and messageId are required.',
    )
    expect(messagesService.moderatorDeleteMessage).not.toHaveBeenCalled()
  })
})

describe('RealtimeInternalController.sendMessageAsUser', () => {
  function makeSeqClient(seq = 7) {
    return { allocateSeq: jest.fn().mockResolvedValue(seq) } as any
  }
  function makeConversationClient() {
    return { updateLastMessage: jest.fn().mockResolvedValue(undefined) } as any
  }
  function makeCreateMessagesService() {
    return {
      createIdempotent: jest.fn().mockResolvedValue({
        id: 'msg-1',
        seq: 7,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        dto: { id: 'msg-1', text: 'hello', conversationId: 'conv-1' },
        reused: false,
      }),
    } as any
  }

  it('allocates a seq, persists the message, and emits it to the conversation room', async () => {
    const { gateway, to, emit } = makeGateway()
    const seqClient = makeSeqClient(7)
    const conversationClient = makeConversationClient()
    const messagesService = makeCreateMessagesService()
    const controller = new RealtimeInternalController(gateway, {} as any, messagesService, seqClient, conversationClient)

    const result = await controller.sendMessageAsUser({
      conversationId: 'conv-1',
      senderId: 'user-1',
      text: 'hello',
    })

    expect(seqClient.allocateSeq).toHaveBeenCalledWith('conv-1')
    expect(messagesService.createIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'user-1',
        conversationId: 'conv-1',
        seq: 7,
        input: expect.objectContaining({ kind: 'text', text: 'hello', conversationId: 'conv-1' }),
      }),
    )
    expect(to).toHaveBeenCalledWith('conv:conv-1')
    expect(emit).toHaveBeenCalledWith('chat.message', expect.objectContaining({ id: 'msg-1', text: 'hello' }))
    expect(conversationClient.updateLastMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', preview: 'hello' }),
    )
    expect(result).toEqual(
      expect.objectContaining({ ok: true, messageId: 'msg-1', seq: 7, conversationId: 'conv-1' }),
    )
  })

  it('generates a clientId when none is provided, and reuses one when given', async () => {
    const { gateway } = makeGateway()
    const messagesService = makeCreateMessagesService()
    const controller = new RealtimeInternalController(
      gateway,
      {} as any,
      messagesService,
      makeSeqClient(),
      makeConversationClient(),
    )

    await controller.sendMessageAsUser({ conversationId: 'conv-1', senderId: 'user-1', text: 'hi' })
    const generatedClientId = messagesService.createIdempotent.mock.calls[0][0].clientId
    expect(typeof generatedClientId).toBe('string')
    expect(generatedClientId.length).toBeGreaterThan(0)

    await controller.sendMessageAsUser({
      conversationId: 'conv-1',
      senderId: 'user-1',
      text: 'hi',
      clientId: 'fixed-client-id',
    })
    expect(messagesService.createIdempotent.mock.calls[1][0].clientId).toBe('fixed-client-id')
  })

  it('rejects when conversationId, senderId, or text is missing', async () => {
    const { gateway } = makeGateway()
    const seqClient = makeSeqClient()
    const controller = new RealtimeInternalController(
      gateway,
      {} as any,
      makeCreateMessagesService(),
      seqClient,
      makeConversationClient(),
    )

    await expect(
      controller.sendMessageAsUser({ senderId: 'user-1', text: 'hi' }),
    ).rejects.toThrow('conversationId, senderId, and text are required.')
    await expect(
      controller.sendMessageAsUser({ conversationId: 'conv-1', text: 'hi' }),
    ).rejects.toThrow('conversationId, senderId, and text are required.')
    await expect(
      controller.sendMessageAsUser({ conversationId: 'conv-1', senderId: 'user-1', text: '   ' }),
    ).rejects.toThrow('conversationId, senderId, and text are required.')
    expect(seqClient.allocateSeq).not.toHaveBeenCalled()
  })

  it('does not throw when the gateway server is unavailable', async () => {
    const messagesService = makeCreateMessagesService()
    const controller = new RealtimeInternalController(
      { server: null } as any,
      {} as any,
      messagesService,
      makeSeqClient(),
      makeConversationClient(),
    )

    const result = await controller.sendMessageAsUser({
      conversationId: 'conv-1',
      senderId: 'user-1',
      text: 'hello',
    })
    expect(result.ok).toBe(true)
  })
})
