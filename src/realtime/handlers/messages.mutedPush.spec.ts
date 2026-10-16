import { runPostSendSideEffects } from './messages'

// Regression coverage: notifyNewMessage previously only checked a
// recipient's GLOBAL "message notifications" preference and DND quiet
// hours - nothing in the push pipeline ever consulted per-conversation
// mute (ConversationMember.is_muted, set by Django's /mute/ action via
// ChatRoomHandlers.tsx's handleMuteConversation). Muting a specific chat
// therefore had zero effect on whether its push notifications kept
// arriving. getMutedMemberIds (DjangoConversationClient) + the skip check
// in runPostSendSideEffects close that gap.

function makeServer(viewerUserIds: string[] = []) {
  const server: any = {
    in: jest.fn(() => ({
      fetchSockets: jest.fn().mockResolvedValue(
        viewerUserIds.map((userId) => ({ principal: { userId } })),
      ),
    })),
  }
  return server
}

describe('runPostSendSideEffects — per-conversation mute skips the push', () => {
  const baseArgs = {
    conversationId: 'conv-1',
    senderId: 'sender-1',
    senderName: 'Sender',
    createdId: 'msg-1',
    seq: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    preview: 'hello',
  }

  it('does not notify a recipient who has muted this conversation', async () => {
    const notifyNewMessage = jest.fn().mockResolvedValue({ ok: true })
    const deps = {
      djangoConversationClient: {
        updateLastMessage: jest.fn().mockResolvedValue(undefined),
        dispatchWebhook: jest.fn().mockResolvedValue({ delivered: 0 }),
        listMemberIds: jest.fn().mockResolvedValue(['sender-1', 'recipient-muted', 'recipient-unmuted']),
        getMutedMemberIds: jest.fn().mockResolvedValue(['recipient-muted']),
      },
      notificationsService: { notifyNewMessage },
    }

    await runPostSendSideEffects(deps as any, makeServer(), baseArgs)

    const notifiedUserIds = notifyNewMessage.mock.calls.map((call) => call[0].toUserId)
    expect(notifiedUserIds).toContain('recipient-unmuted')
    expect(notifiedUserIds).not.toContain('recipient-muted')
    expect(notifiedUserIds).not.toContain('sender-1')
  });

  it('still notifies everyone when getMutedMemberIds is unavailable (optional dep, e.g. older test doubles)', async () => {
    const notifyNewMessage = jest.fn().mockResolvedValue({ ok: true })
    const deps = {
      djangoConversationClient: {
        updateLastMessage: jest.fn().mockResolvedValue(undefined),
        dispatchWebhook: jest.fn().mockResolvedValue({ delivered: 0 }),
        listMemberIds: jest.fn().mockResolvedValue(['sender-1', 'recipient-1']),
        // getMutedMemberIds intentionally omitted
      },
      notificationsService: { notifyNewMessage },
    }

    await runPostSendSideEffects(deps as any, makeServer(), baseArgs)

    expect(notifyNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 'recipient-1' }),
    )
  });

  it('fails open (notifies) when getMutedMemberIds itself rejects', async () => {
    const notifyNewMessage = jest.fn().mockResolvedValue({ ok: true })
    const deps = {
      djangoConversationClient: {
        updateLastMessage: jest.fn().mockResolvedValue(undefined),
        dispatchWebhook: jest.fn().mockResolvedValue({ delivered: 0 }),
        listMemberIds: jest.fn().mockResolvedValue(['sender-1', 'recipient-1']),
        getMutedMemberIds: jest.fn().mockRejectedValue(new Error('django unreachable')),
      },
      notificationsService: { notifyNewMessage },
    }

    await runPostSendSideEffects(deps as any, makeServer(), baseArgs)

    expect(notifyNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ toUserId: 'recipient-1' }),
    )
  });

  it('a muted recipient actively viewing the conversation is still correctly skipped for the viewing reason, not double-counted', async () => {
    const notifyNewMessage = jest.fn().mockResolvedValue({ ok: true })
    const deps = {
      djangoConversationClient: {
        updateLastMessage: jest.fn().mockResolvedValue(undefined),
        dispatchWebhook: jest.fn().mockResolvedValue({ delivered: 0 }),
        listMemberIds: jest.fn().mockResolvedValue(['sender-1', 'recipient-1']),
        getMutedMemberIds: jest.fn().mockResolvedValue(['recipient-1']),
      },
      notificationsService: { notifyNewMessage },
    }

    await runPostSendSideEffects(deps as any, makeServer(['recipient-1']), baseArgs)

    expect(notifyNewMessage).not.toHaveBeenCalled()
  });
});
