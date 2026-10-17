import { registerStatusDiscussionHandlers, StatusDiscussionDeps } from './statusDiscussions'
import { EVT, rooms } from '../../chat/chat.types'

// Regression coverage: status.join must re-verify visibility against
// Django (can_view_status, via DjangoConversationClient.canViewStatus)
// before letting a socket subscribe to a status's reaction/comment room -
// without this, anyone could join status:{id} by guessing/leaking an id
// and eavesdrop on a private status's discussion even though every REST
// endpoint for it is locked down to the author's audience.

function makeSocket(userId = 'viewer-1') {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket: any = {
    principal: { userId, token: 'jwt' },
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler)
    }),
    join: jest.fn(),
    leave: jest.fn(),
  }
  return { socket, handlers }
}

function makeDeps(canView: boolean): StatusDiscussionDeps {
  return {
    djangoConversationClient: {
      canViewStatus: jest.fn().mockResolvedValue(canView),
    },
  } as unknown as StatusDiscussionDeps
}

describe('status.join / status.leave', () => {
  it('joins the status room when Django confirms the viewer can see the status', async () => {
    const { socket, handlers } = makeSocket()
    const deps = makeDeps(true)
    registerStatusDiscussionHandlers({} as any, socket, deps)

    const ack = jest.fn()
    await handlers.get(EVT.STATUS_JOIN)!({ statusId: 'status-1' }, ack)

    expect(deps.djangoConversationClient.canViewStatus).toHaveBeenCalledWith('viewer-1', 'status-1')
    expect(socket.join).toHaveBeenCalledWith(rooms.statusRoom('status-1'))
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('refuses to join when Django says the viewer cannot see the status', async () => {
    const { socket, handlers } = makeSocket()
    const deps = makeDeps(false)
    registerStatusDiscussionHandlers({} as any, socket, deps)

    const ack = jest.fn()
    await handlers.get(EVT.STATUS_JOIN)!({ statusId: 'status-private' }, ack)

    expect(socket.join).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('refuses to join when Django is unreachable (canViewStatus fails closed)', async () => {
    const { socket, handlers } = makeSocket()
    const deps: StatusDiscussionDeps = {
      djangoConversationClient: {
        canViewStatus: jest.fn().mockRejectedValue(new Error('django unreachable')),
      },
    } as unknown as StatusDiscussionDeps
    registerStatusDiscussionHandlers({} as any, socket, deps)

    const ack = jest.fn()
    await handlers.get(EVT.STATUS_JOIN)!({ statusId: 'status-1' }, ack)

    expect(socket.join).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('rejects a join with no statusId without ever calling Django', async () => {
    const { socket, handlers } = makeSocket()
    const deps = makeDeps(true)
    registerStatusDiscussionHandlers({} as any, socket, deps)

    const ack = jest.fn()
    await handlers.get(EVT.STATUS_JOIN)!({}, ack)

    expect(deps.djangoConversationClient.canViewStatus).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('leave removes the socket from the status room', () => {
    const { socket, handlers } = makeSocket()
    registerStatusDiscussionHandlers({} as any, socket, makeDeps(true))

    const ack = jest.fn()
    handlers.get(EVT.STATUS_LEAVE)!({ statusId: 'status-1' }, ack)

    expect(socket.leave).toHaveBeenCalledWith(rooms.statusRoom('status-1'))
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })
})
