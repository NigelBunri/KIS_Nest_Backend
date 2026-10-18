import { registerCallHandlers, CallsDeps } from './calls'

// call.ringing (the callee telling the caller "I'm actually alerting the
// user now") unconditionally called assertMember with no invite-link/
// direct-invite bypass, unlike every other call.* handler in this file —
// so a non-member who received the offer via a shared link or call.invite
// got "Not a conversation member" logged as an ERROR on every single call,
// even though the rejection has no visible client effect (this event is
// fire-and-forget, no ack is awaited client-side).

function makeSocket(userId = 'user-2') {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId, token: 'jwt' },
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler)
    }),
  }
  return { socket, handlers }
}

function makeServer() {
  const emitsByRoom = new Map<string, jest.Mock>()
  const server: any = {
    to: jest.fn((room: string) => {
      if (!emitsByRoom.has(room)) emitsByRoom.set(room, jest.fn())
      return { emit: emitsByRoom.get(room) }
    }),
  }
  return { server, emitsByRoom }
}

describe('call.ringing invite-eligibility bypass', () => {
  it('delivers the ringing signal for a non-member who holds a valid invite token', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps: CallsDeps = {
      djangoConversationClient: {
        assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
      },
      callsService: {
        getCallCreator: jest.fn().mockResolvedValue('user-1'),
        hasActiveInviteToken: jest.fn().mockResolvedValue(true),
        isInvitedParticipant: jest.fn().mockResolvedValue(false),
      },
    } as any
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.ringing')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('still rejects a non-member with no invite token and no direct invite', async () => {
    const { socket, handlers } = makeSocket('user-2')
    const { server } = makeServer()
    const ack = jest.fn()
    const deps: CallsDeps = {
      djangoConversationClient: {
        assertMember: jest.fn().mockRejectedValue(new Error('Not a conversation member')),
      },
      callsService: {
        getCallCreator: jest.fn(),
        hasActiveInviteToken: jest.fn().mockResolvedValue(false),
        isInvitedParticipant: jest.fn().mockResolvedValue(false),
      },
    } as any
    registerCallHandlers(server as any, socket, deps)

    await handlers.get('call.ringing')!({ conversationId: 'conv-123', callId: 'call-1' }, ack)

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })
})
