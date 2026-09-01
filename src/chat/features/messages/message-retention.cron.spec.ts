import { MessageRetentionCron } from './message-retention.cron'

describe('MessageRetentionCron.scrubOldDeletedMessages', () => {
  const originalEnv = process.env.MESSAGE_DELETED_RETENTION_DAYS

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MESSAGE_DELETED_RETENTION_DAYS
    else process.env.MESSAGE_DELETED_RETENTION_DAYS = originalEnv
  })

  it('calls the service with a cutoff derived from the default retention window', async () => {
    delete process.env.MESSAGE_DELETED_RETENTION_DAYS
    const messagesService = { scrubContentForMessagesDeletedBefore: jest.fn().mockResolvedValue({ scrubbed: 3 }) } as any
    const cron = new MessageRetentionCron(messagesService)
    const before = Date.now() - 30 * 24 * 60 * 60 * 1000

    await cron.scrubOldDeletedMessages()

    const cutoffArg = messagesService.scrubContentForMessagesDeletedBefore.mock.calls[0][0]
    expect(cutoffArg).toBeLessThanOrEqual(before + 1000)
    expect(cutoffArg).toBeGreaterThan(before - 5000)
  })

  it('honors a configured retention window', async () => {
    process.env.MESSAGE_DELETED_RETENTION_DAYS = '7'
    const messagesService = { scrubContentForMessagesDeletedBefore: jest.fn().mockResolvedValue({ scrubbed: 0 }) } as any
    const cron = new MessageRetentionCron(messagesService)
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000

    await cron.scrubOldDeletedMessages()

    const cutoffArg = messagesService.scrubContentForMessagesDeletedBefore.mock.calls[0][0]
    expect(Math.abs(cutoffArg - expected)).toBeLessThan(5000)
  })

  it('does not throw when the service call fails', async () => {
    const messagesService = {
      scrubContentForMessagesDeletedBefore: jest.fn().mockRejectedValue(new Error('mongo down')),
    } as any
    const cron = new MessageRetentionCron(messagesService)

    await expect(cron.scrubOldDeletedMessages()).resolves.toBeUndefined()
  })
})
