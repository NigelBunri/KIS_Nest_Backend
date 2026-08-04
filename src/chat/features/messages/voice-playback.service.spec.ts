import { NotFoundException, ForbiddenException } from '@nestjs/common'
import { VoicePlaybackService } from './voice-playback.service'

const VALID_OBJECT_ID = '507f1f77bcf86cd799439011'

function buildModel(message: any) {
  const exec = jest.fn().mockResolvedValue(message)
  const lean = jest.fn(() => ({ exec }))
  const findOne = jest.fn(() => ({ lean }))
  return { findOne }
}

describe('VoicePlaybackService.resolvePlaybackUrl', () => {
  const principal = { userId: 'user-1', token: 'tok' }

  it('returns a signed url for a member of the conversation', async () => {
    const message = {
      _id: VALID_OBJECT_ID,
      conversationId: 'conv-1',
      kind: 'voice',
      isDeleted: false,
      voice: { mediaAssetId: 'asset-1', objectKey: 'legacy-key' },
    }
    const model = buildModel(message)
    const conv = { assertMember: jest.fn().mockResolvedValue({ isMember: true }) }
    const media = { signChatVoiceAsset: jest.fn().mockResolvedValue({ url: 'https://s3/x', expiresAt: '2026-01-01T00:00:00Z', expiresInSeconds: 900 }) }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)
    const result = await service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)

    expect(result.url).toBe('https://s3/x')
    expect(conv.assertMember).toHaveBeenCalledWith(principal, 'conv-1')
  })

  it('derives the mediaAssetId/objectKey from the PERSISTED message, never from caller input', async () => {
    const message = {
      _id: VALID_OBJECT_ID,
      conversationId: 'conv-1',
      kind: 'voice',
      isDeleted: false,
      voice: { mediaAssetId: 'trusted-asset-id', objectKey: 'trusted-key' },
    }
    const model = buildModel(message)
    const conv = { assertMember: jest.fn().mockResolvedValue({ isMember: true }) }
    const media = { signChatVoiceAsset: jest.fn().mockResolvedValue({ url: 'https://s3/x', expiresAt: 'x', expiresInSeconds: 900 }) }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)
    // resolvePlaybackUrl's signature only accepts (messageId, principal) —
    // there is structurally no parameter for a client to pass an object
    // key/asset id through. This asserts what actually reaches Django came
    // from the message document, not any caller-supplied value.
    await service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)

    expect(media.signChatVoiceAsset).toHaveBeenCalledWith({
      mediaAssetId: 'trusted-asset-id',
      objectKey: 'trusted-key',
    })
  })

  it('denies a user who is not a member of the conversation', async () => {
    const message = {
      _id: VALID_OBJECT_ID,
      conversationId: 'conv-1',
      kind: 'voice',
      isDeleted: false,
      voice: { mediaAssetId: 'asset-1' },
    }
    const model = buildModel(message)
    const conv = { assertMember: jest.fn().mockRejectedValue(new Error('not a member')) }
    const media = { signChatVoiceAsset: jest.fn() }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)

    await expect(service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)).rejects.toBeInstanceOf(ForbiddenException)
    expect(media.signChatVoiceAsset).not.toHaveBeenCalled()
  })

  it('covers both direct-chat and group-chat conversation ids identically (delegates membership to DjangoConversationClient either way)', async () => {
    for (const conversationId of ['direct:user-1:user-2', 'group-abc123']) {
      const message = {
        _id: VALID_OBJECT_ID,
        conversationId,
        kind: 'voice',
        isDeleted: false,
        voice: { mediaAssetId: 'asset-1' },
      }
      const model = buildModel(message)
      const conv = { assertMember: jest.fn().mockResolvedValue({ isMember: true }) }
      const media = { signChatVoiceAsset: jest.fn().mockResolvedValue({ url: 'x', expiresAt: 'x', expiresInSeconds: 900 }) }

      const service = new VoicePlaybackService(model as any, conv as any, media as any)
      await service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)

      expect(conv.assertMember).toHaveBeenCalledWith(principal, conversationId)
    }
  })

  it('returns a typed not-found for a message that has no voice attachment', async () => {
    const message = { _id: VALID_OBJECT_ID, conversationId: 'conv-1', kind: 'text', isDeleted: false, voice: undefined }
    const model = buildModel(message)
    const conv = { assertMember: jest.fn() }
    const media = { signChatVoiceAsset: jest.fn() }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)

    await expect(service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)).rejects.toBeInstanceOf(NotFoundException)
    expect(conv.assertMember).not.toHaveBeenCalled()
  })

  it('returns a typed not-found for a nonexistent message', async () => {
    const model = buildModel(null)
    const conv = { assertMember: jest.fn() }
    const media = { signChatVoiceAsset: jest.fn() }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)

    await expect(service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('returns a typed not-found — not a 500 — for a garbage messageId that is not a valid ObjectId', async () => {
    const model = buildModel(null)
    const conv = { assertMember: jest.fn() }
    const media = { signChatVoiceAsset: jest.fn() }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)

    await expect(service.resolvePlaybackUrl('not-an-object-id', principal)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('returns a typed not-found for a historical message with neither mediaAssetId nor objectKey (unrecoverable — never fabricates access)', async () => {
    const message = {
      _id: VALID_OBJECT_ID,
      conversationId: 'conv-1',
      kind: 'voice',
      isDeleted: false,
      voice: { durationMs: 4000 }, // pre-fix row: everything else was stripped
    }
    const model = buildModel(message)
    const conv = { assertMember: jest.fn().mockResolvedValue({ isMember: true }) }
    const media = { signChatVoiceAsset: jest.fn() }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)

    await expect(service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)).rejects.toBeInstanceOf(NotFoundException)
    expect(media.signChatVoiceAsset).not.toHaveBeenCalled()
  })

  it('propagates a Django/upstream failure as a typed error rather than swallowing it', async () => {
    const message = {
      _id: VALID_OBJECT_ID,
      conversationId: 'conv-1',
      kind: 'voice',
      isDeleted: false,
      voice: { mediaAssetId: 'asset-1' },
    }
    const model = buildModel(message)
    const conv = { assertMember: jest.fn().mockResolvedValue({ isMember: true }) }
    const upstreamError = new Error('Could not reach the media signing service. Please try again.')
    const media = { signChatVoiceAsset: jest.fn().mockRejectedValue(upstreamError) }

    const service = new VoicePlaybackService(model as any, conv as any, media as any)

    await expect(service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)).rejects.toBe(upstreamError)
  })

  it('never logs anything (no signed URL / internal token leakage risk) on either a successful or failed resolution', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const message = {
        _id: VALID_OBJECT_ID,
        conversationId: 'conv-1',
        kind: 'voice',
        isDeleted: false,
        voice: { mediaAssetId: 'asset-1' },
      }
      const model = buildModel(message)
      const conv = { assertMember: jest.fn().mockResolvedValue({ isMember: true }) }
      const media = {
        signChatVoiceAsset: jest
          .fn()
          .mockResolvedValueOnce({ url: 'https://s3/signed?sig=SECRET', expiresAt: 'x', expiresInSeconds: 900 })
          .mockRejectedValueOnce(new Error('boom')),
      }

      const service = new VoicePlaybackService(model as any, conv as any, media as any)
      await service.resolvePlaybackUrl(VALID_OBJECT_ID, principal)
      await service.resolvePlaybackUrl(VALID_OBJECT_ID, principal).catch(() => {})

      expect(logSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
