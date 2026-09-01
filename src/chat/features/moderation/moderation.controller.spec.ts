import { ModerationController } from './moderation.controller'

function makeReq(userId = 'user-1') {
  return {
    headers: { authorization: 'Bearer jwt-token', 'x-device-id': 'device-1' },
  } as any
}

function makeAuthService(userId = 'user-1') {
  return { introspect: jest.fn().mockResolvedValue({ userId }) } as any
}

describe('ModerationController.report — mirrors the report into Django', () => {
  it('calls notifyMessageReported after writing the local report, and still succeeds if it fails', async () => {
    const moderationService = { reportMessage: jest.fn().mockResolvedValue({ ok: true }) } as any
    const djangoConversationClient = {
      assertMember: jest.fn().mockResolvedValue({ isMember: true }),
      notifyMessageReported: jest.fn().mockRejectedValue(new Error('django unreachable')),
    } as any
    const controller = new ModerationController(moderationService, makeAuthService(), djangoConversationClient)

    const result = await controller.report(makeReq(), {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      reason: 'spam',
      note: 'annoying',
    })

    expect(result).toEqual({ ok: true })
    expect(moderationService.reportMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      reportedBy: 'user-1',
      reason: 'spam',
      note: 'annoying',
    })
    // notifyMessageReported is fire-and-forget from the controller's point of
    // view - awaiting the controller call must not depend on it resolving.
    expect(djangoConversationClient.notifyMessageReported).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      reportedBy: 'user-1',
      reason: 'spam',
      note: 'annoying',
    })
  })

  it('requires membership before recording the report', async () => {
    const moderationService = { reportMessage: jest.fn() } as any
    const djangoConversationClient = {
      assertMember: jest.fn().mockRejectedValue(new Error('not a member')),
      notifyMessageReported: jest.fn(),
    } as any
    const controller = new ModerationController(moderationService, makeAuthService(), djangoConversationClient)

    await expect(
      controller.report(makeReq(), { conversationId: 'conv-1', messageId: 'msg-1' }),
    ).rejects.toThrow('not a member')

    expect(moderationService.reportMessage).not.toHaveBeenCalled()
    expect(djangoConversationClient.notifyMessageReported).not.toHaveBeenCalled()
  })
})
