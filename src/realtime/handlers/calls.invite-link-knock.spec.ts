import { registerCallHandlers, CallsDeps } from './calls'

// Reproduces the reported production bug: a non-member who joined an
// ongoing call's conversation through a valid shared invite link got
// "Can't join, session expired" at the call.answer/call.ice stage (fixed
// separately, see calls.invite-link-answer.spec.ts) — but the actual
// mid-call "let me in" request, call.knock, had its OWN unconditional
// djangoConversationClient.assertMember() check with no invite-link
// fallback at all, so the knock itself was rejected before it ever
// reached the host's waiting-room UI. The user was never even offered
// the chance to wait to be admitted.

function makeSocket(userId = 'user-2') {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId, token: 'jwt' },
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler)
    }),
    join: jest.fn(),
    emit: jest.fn(),
  }
  return { socket, handlers }
}

function makeServer() {
  const server: any = {
    to: jest.fn(() => ({ emit: jest.fn() })),
    in: jest.fn(() => ({ socketsJoin: jest.fn() })),
  }
  return server
}

function makeDeps(overrides: Partial<CallsDeps> = {}): CallsDeps {
  return {
    djangoConversationClient: {
      assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
      checkBlockedAmong: jest.fn().mockResolvedValue([]),
    },
    callsService: {
      hasActiveInviteToken: jest.fn().mockResolvedValue(true),
      addKnocker: jest.fn(),
    },
    ...overrides,
  } as CallsDeps
}

describe('call.knock invite-link bypass for a real (non-standalone) conversation', () => {
  it('lets a non-member knock on an active call when it has an active invite token', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const server = makeServer()
    const ack = jest.fn()
    const deps = makeDeps()
    registerCallHandlers(server, socket, deps)

    await handlers.get('call.knock')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(deps.djangoConversationClient.assertMember).toHaveBeenCalled()
    expect((deps.callsService as any).hasActiveInviteToken).toHaveBeenCalledWith('conv-123', 'call-1')
    expect((deps.callsService as any).addKnocker).toHaveBeenCalledWith('conv-123', 'call-1', 'user-2')
    expect(ack).not.toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('still rejects a non-member knock when the call has NO invite token', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const server = makeServer()
    const ack = jest.fn()
    const deps = makeDeps({
      callsService: {
        hasActiveInviteToken: jest.fn().mockResolvedValue(false),
        addKnocker: jest.fn(),
      } as any,
    })
    registerCallHandlers(server, socket, deps)

    await handlers.get('call.knock')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect((deps.callsService as any).addKnocker).not.toHaveBeenCalled()
  })

  it('never calls hasActiveInviteToken when the caller IS already a conversation member', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const server = makeServer()
    const deps = makeDeps({
      djangoConversationClient: {
        assertMember: jest.fn().mockResolvedValue(undefined),
        checkBlockedAmong: jest.fn().mockResolvedValue([]),
      },
    })
    registerCallHandlers(server, socket, deps)

    await handlers.get('call.knock')!({ conversationId: 'conv-123', callId: 'call-1' }, jest.fn())

    expect((deps.callsService as any).hasActiveInviteToken).not.toHaveBeenCalled()
    expect((deps.callsService as any).addKnocker).toHaveBeenCalledWith('conv-123', 'call-1', 'user-2')
  })

  it('skips Django membership entirely for a standalone call', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const server = makeServer()
    const assertMember = jest.fn()
    const deps = makeDeps({
      djangoConversationClient: { assertMember, checkBlockedAmong: jest.fn().mockResolvedValue([]) },
    })
    registerCallHandlers(server, socket, deps)

    await handlers.get('call.knock')!({ conversationId: 'standalone:call-1', callId: 'call-1' }, jest.fn())

    expect(assertMember).not.toHaveBeenCalled()
    expect((deps.callsService as any).addKnocker).toHaveBeenCalledWith('standalone:call-1', 'call-1', 'user-2')
  })
})
