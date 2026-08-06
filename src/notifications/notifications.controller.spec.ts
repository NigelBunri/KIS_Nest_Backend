import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import { NotificationsController } from './notifications.controller'

function buildDeps() {
  const auth = { introspect: jest.fn() }
  const tokens = { upsert: jest.fn(), deactivate: jest.fn(), deactivateForDevice: jest.fn() }
  return { auth, tokens }
}

describe('NotificationsController.registerToken', () => {
  it('rejects a request with no bearer token', async () => {
    const { auth, tokens } = buildDeps()
    const controller = new NotificationsController(auth as any, tokens as any)

    await expect(
      controller.registerToken(undefined, { token: 't1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException)
    expect(tokens.upsert).not.toHaveBeenCalled()
  })

  it('rejects a bearer token Django cannot introspect', async () => {
    const { auth, tokens } = buildDeps()
    auth.introspect.mockResolvedValue(null)
    const controller = new NotificationsController(auth as any, tokens as any)

    await expect(
      controller.registerToken('Bearer bad-token', { token: 't1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('upserts the token for the introspected user', async () => {
    const { auth, tokens } = buildDeps()
    auth.introspect.mockResolvedValue({ userId: 'user-1' })
    const controller = new NotificationsController(auth as any, tokens as any)

    const result = await controller.registerToken('Bearer good-token', {
      token: 'push-token', platform: 'ios', deviceId: 'device-1',
    })

    expect(result).toEqual({ ok: true })
    expect(tokens.upsert).toHaveBeenCalledWith({
      userId: 'user-1', token: 'push-token', platform: 'ios', deviceId: 'device-1', tokenType: 'fcm',
    })
  })

  it('returns a typed response instead of upserting when the token is missing', async () => {
    const { auth, tokens } = buildDeps()
    auth.introspect.mockResolvedValue({ userId: 'user-1' })
    const controller = new NotificationsController(auth as any, tokens as any)

    const result = await controller.registerToken('Bearer good-token', {});
    expect(result).toEqual({ ok: false, reason: 'token_required' })
    expect(tokens.upsert).not.toHaveBeenCalled()
  })
})

describe('NotificationsController.unregisterToken', () => {
  it('requires authentication, same as register', async () => {
    const { auth, tokens } = buildDeps()
    const controller = new NotificationsController(auth as any, tokens as any)

    await expect(
      controller.unregisterToken(undefined, { token: 't1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('requires at least a token or a deviceId', async () => {
    const { auth, tokens } = buildDeps()
    auth.introspect.mockResolvedValue({ userId: 'user-1' })
    const controller = new NotificationsController(auth as any, tokens as any)

    await expect(controller.unregisterToken('Bearer t', {})).rejects.toBeInstanceOf(BadRequestException)
    expect(tokens.deactivate).not.toHaveBeenCalled()
    expect(tokens.deactivateForDevice).not.toHaveBeenCalled()
  })

  it('deactivates by exact token when given one', async () => {
    const { auth, tokens } = buildDeps()
    auth.introspect.mockResolvedValue({ userId: 'user-1' })
    const controller = new NotificationsController(auth as any, tokens as any)

    await controller.unregisterToken('Bearer t', { token: 'push-token' })
    expect(tokens.deactivate).toHaveBeenCalledWith({ userId: 'user-1', token: 'push-token' })
    expect(tokens.deactivateForDevice).not.toHaveBeenCalled()
  })

  it('deactivates by deviceId when no exact token is known (e.g. storage already cleared)', async () => {
    const { auth, tokens } = buildDeps()
    auth.introspect.mockResolvedValue({ userId: 'user-1' })
    const controller = new NotificationsController(auth as any, tokens as any)

    await controller.unregisterToken('Bearer t', { deviceId: 'device-1' })
    expect(tokens.deactivateForDevice).toHaveBeenCalledWith({ userId: 'user-1', deviceId: 'device-1' })
    expect(tokens.deactivate).not.toHaveBeenCalled()
  })

  it('runs both when both are provided', async () => {
    const { auth, tokens } = buildDeps()
    auth.introspect.mockResolvedValue({ userId: 'user-1' })
    const controller = new NotificationsController(auth as any, tokens as any)

    await controller.unregisterToken('Bearer t', { token: 'push-token', deviceId: 'device-1' })
    expect(tokens.deactivate).toHaveBeenCalledWith({ userId: 'user-1', token: 'push-token' })
    expect(tokens.deactivateForDevice).toHaveBeenCalledWith({ userId: 'user-1', deviceId: 'device-1' })
  })
})
