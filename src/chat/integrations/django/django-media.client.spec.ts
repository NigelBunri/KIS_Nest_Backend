import { of, throwError } from 'rxjs'
import { BadGatewayException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { DjangoMediaClient } from './django-media.client'

function buildHttp(impl: () => any) {
  return { post: jest.fn(impl) } as any
}

describe('DjangoMediaClient.signChatVoiceAsset', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV, DJANGO_API_URL: 'https://django.internal/api/v1', DJANGO_INTERNAL_TOKEN: 'secret' }
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('returns the signed url on success', async () => {
    const http = buildHttp(() =>
      of({ data: { url: 'https://s3/x?sig=abc', expiresAt: '2026-01-01T00:00:00Z', expiresInSeconds: 900 } }),
    )
    const client = new DjangoMediaClient(http)

    const result = await client.signChatVoiceAsset({ mediaAssetId: 'asset-1' })

    expect(result.url).toBe('https://s3/x?sig=abc')
    expect(http.post).toHaveBeenCalledWith(
      'https://django.internal/api/v1/media/internal/chat-voice/sign/',
      { mediaAssetId: 'asset-1' },
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('never sends a client-supplied objectKey unless explicitly passed by the caller (VoicePlaybackService), and omits it when absent', async () => {
    const http = buildHttp(() => of({ data: { url: 'x', expiresAt: 'x', expiresInSeconds: 900 } }))
    const client = new DjangoMediaClient(http)

    await client.signChatVoiceAsset({ mediaAssetId: 'asset-1' })

    const body = http.post.mock.calls[0][1]
    expect(body).toEqual({ mediaAssetId: 'asset-1' })
    expect(body.objectKey).toBeUndefined()
  })

  it('maps a Django 404 to NotFoundException', async () => {
    const http = buildHttp(() => throwError(() => ({ response: { status: 404 } })))
    const client = new DjangoMediaClient(http)

    await expect(client.signChatVoiceAsset({ mediaAssetId: 'asset-1' })).rejects.toBeInstanceOf(NotFoundException)
  })

  it('maps a Django 403 to ForbiddenException', async () => {
    const http = buildHttp(() => throwError(() => ({ response: { status: 403 } })))
    const client = new DjangoMediaClient(http)

    await expect(client.signChatVoiceAsset({ mediaAssetId: 'asset-1' })).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('maps a network failure / timeout / 5xx to a typed BadGatewayException instead of leaking a raw error', async () => {
    const http = buildHttp(() => throwError(() => new Error('ECONNREFUSED')))
    const client = new DjangoMediaClient(http)

    await expect(client.signChatVoiceAsset({ mediaAssetId: 'asset-1' })).rejects.toBeInstanceOf(BadGatewayException)
  })

  it('throws BadGatewayException when Django is unreachable/misconfigured (no URL) rather than silently no-op-ing', async () => {
    process.env.DJANGO_API_URL = ''
    process.env.DJANGO_INTROSPECT_URL = ''
    process.env.DJANGO_CHAT_VOICE_SIGN_URL = ''
    const http = buildHttp(() => of({ data: {} }))
    const client = new DjangoMediaClient(http)

    await expect(client.signChatVoiceAsset({ mediaAssetId: 'asset-1' })).rejects.toBeInstanceOf(BadGatewayException)
    expect(http.post).not.toHaveBeenCalled()
  })

  it('never logs the signed URL or the internal token', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const http = buildHttp(() =>
        of({ data: { url: 'https://s3/x?sig=SUPER_SECRET', expiresAt: 'x', expiresInSeconds: 900 } }),
      )
      const client = new DjangoMediaClient(http)
      await client.signChatVoiceAsset({ mediaAssetId: 'asset-1' })

      const failingHttp = buildHttp(() => throwError(() => new Error('boom')))
      const failingClient = new DjangoMediaClient(failingHttp)
      await failingClient.signChatVoiceAsset({ mediaAssetId: 'asset-1' }).catch(() => {})

      for (const spy of [logSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          const serialized = JSON.stringify(call)
          expect(serialized).not.toContain('SUPER_SECRET')
          expect(serialized).not.toContain('secret'); // DJANGO_INTERNAL_TOKEN value
        }
      }
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
