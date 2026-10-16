import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import { ScheduledMessagesController } from './scheduled-messages.controller'

function makeReq(token = 'valid-token') {
  return { headers: { authorization: token ? `Bearer ${token}` : '', 'x-device-id': 'device-1' } } as any
}

function makeDeps() {
  const scheduledMessagesService = {
    schedule: jest.fn(),
    listPending: jest.fn(),
    reschedule: jest.fn(),
    cancel: jest.fn(),
    getOwned: jest.fn(),
  }
  const scheduledMessagesCron = { notifyOwnerOfStatus: jest.fn() }
  const authService = { introspect: jest.fn().mockResolvedValue({ userId: 'user-1', username: 'Alice', deviceId: 'device-1' }) }
  const djangoConversationClient = {
    assertMember: jest.fn().mockResolvedValue({ isMember: true, isBlocked: false, canSend: true }),
  }
  const moderationService = { assertAllowed: jest.fn().mockResolvedValue(undefined) }
  return { scheduledMessagesService, scheduledMessagesCron, authService, djangoConversationClient, moderationService }
}

function makeController(deps = makeDeps()) {
  const controller = new ScheduledMessagesController(
    deps.scheduledMessagesService as any,
    deps.scheduledMessagesCron as any,
    deps.authService as any,
    deps.djangoConversationClient as any,
    deps.moderationService as any,
  )
  return { controller, deps }
}

const future = (ms: number) => new Date(Date.now() + ms).toISOString()

describe('ScheduledMessagesController', () => {
  it('rejects requests with no bearer token', async () => {
    const { controller } = makeController()
    await expect(controller.schedule(makeReq(''), {} as any)).rejects.toThrow(UnauthorizedException)
  })

  describe('schedule', () => {
    it('requires conversationId, clientId, kind, and scheduledAt', async () => {
      const { controller } = makeController()
      await expect(
        controller.schedule(makeReq(), { conversationId: 'c1' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('rejects an unparseable scheduledAt', async () => {
      const { controller } = makeController()
      await expect(
        controller.schedule(makeReq(), {
          conversationId: 'c1',
          clientId: 'cl1',
          kind: 'text',
          scheduledAt: 'not-a-date',
        }),
      ).rejects.toThrow(BadRequestException)
    })

    it('refuses to schedule into a conversation the sender cannot send in', async () => {
      const deps = makeDeps()
      deps.djangoConversationClient.assertMember.mockResolvedValue({ isMember: false })
      const { controller } = makeController(deps)

      await expect(
        controller.schedule(makeReq(), {
          conversationId: 'c1',
          clientId: 'cl1',
          kind: 'text',
          text: 'hi',
          scheduledAt: future(60_000),
        }),
      ).rejects.toThrow(UnauthorizedException)
      expect(deps.scheduledMessagesService.schedule).not.toHaveBeenCalled()
    })

    it('schedules a valid message and returns a client-safe view (no raw payload echoed back)', async () => {
      const deps = makeDeps()
      deps.scheduledMessagesService.schedule.mockResolvedValue({
        _id: 'm1',
        conversationId: 'c1',
        scheduledAt: new Date('2026-02-01T00:00:00Z'),
        status: 'scheduled',
        attempts: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        payload: { kind: 'text', text: 'hi there' },
      })
      const { controller } = makeController(deps)

      const result = await controller.schedule(makeReq(), {
        conversationId: 'c1',
        clientId: 'cl1',
        kind: 'text',
        text: 'hi there',
        scheduledAt: future(60_000),
      })

      expect(deps.scheduledMessagesService.schedule).toHaveBeenCalledWith({
        conversationId: 'c1',
        senderId: 'user-1',
        senderDeviceId: 'device-1',
        senderName: 'Alice',
        clientId: 'cl1',
        payload: { conversationId: 'c1', clientId: 'cl1', kind: 'text', text: 'hi there' },
        scheduledAt: expect.any(Date),
      })
      expect(result.ok).toBe(true)
      expect(result.data.id).toBe('m1')
      expect(result.data.preview.text).toBe('hi there')
      expect((result.data as any).payload).toBeUndefined()
    })

    it('never leaks ciphertext as a plaintext preview', async () => {
      const deps = makeDeps()
      deps.scheduledMessagesService.schedule.mockResolvedValue({
        _id: 'm1',
        conversationId: 'c1',
        scheduledAt: new Date(),
        status: 'scheduled',
        attempts: 0,
        createdAt: new Date(),
        payload: { kind: 'text', ciphertext: 'abc123', text: 'should-never-appear' },
      })
      const { controller } = makeController(deps)

      const result = await controller.schedule(makeReq(), {
        conversationId: 'c1',
        clientId: 'cl1',
        kind: 'text',
        ciphertext: 'abc123',
        scheduledAt: future(60_000),
      })

      expect(result.data.preview.text).toBeUndefined()
    })
  })

  describe('cancel', () => {
    it('reports success and notifies other devices when cancellation succeeds', async () => {
      const deps = makeDeps()
      deps.scheduledMessagesService.cancel.mockResolvedValue({ ok: true, status: 'cancelled' })
      deps.scheduledMessagesService.getOwned.mockResolvedValue({ _id: 'm1', senderId: 'user-1', status: 'cancelled' })
      const { controller } = makeController(deps)

      const result = await controller.cancel(makeReq(), 'm1')

      expect(result).toEqual({ ok: true, status: 'cancelled' })
      expect(deps.scheduledMessagesCron.notifyOwnerOfStatus).toHaveBeenCalledWith(
        { _id: 'm1', senderId: 'user-1', status: 'cancelled' },
        'cancelled',
      )
    })

    it('never claims success for a message that already became irreversible', async () => {
      const deps = makeDeps()
      deps.scheduledMessagesService.cancel.mockResolvedValue({ ok: false, status: 'sent' })
      const { controller } = makeController(deps)

      const result = await controller.cancel(makeReq(), 'm1')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('already sent')
      expect(deps.scheduledMessagesCron.notifyOwnerOfStatus).not.toHaveBeenCalled()
    })
  })

  describe('reschedule', () => {
    it('rejects an invalid new scheduledAt', async () => {
      const { controller } = makeController()
      await expect(
        controller.reschedule(makeReq(), 'm1', { scheduledAt: 'nonsense' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('reports why editing is refused once the message is no longer editable', async () => {
      const deps = makeDeps()
      deps.scheduledMessagesService.reschedule.mockResolvedValue({ ok: false, status: 'processing' })
      const { controller } = makeController(deps)

      const result = await controller.reschedule(makeReq(), 'm1', { scheduledAt: future(60_000) })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('already processing')
    })
  })
})
