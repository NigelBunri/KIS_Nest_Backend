import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { VoiceDto } from './messages.dto'

describe('VoiceDto', () => {
  it('accepts and preserves the full canonical voice-attachment payload', async () => {
    const dto = plainToInstance(VoiceDto, {
      durationMs: 4200,
      id: 'upload-1',
      url: 'https://cdn.example.com/voice/abc.m4a?sig=redacted',
      mediaAssetId: 'asset-42',
      objectKey: 'asset-42',
      originalName: 'note.m4a',
      mimeType: 'audio/mp4',
      size: 51200,
      waveform: [1, 2, 3],
      urlExpiresAt: '2026-01-01T00:15:00.000Z',
    })

    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
    expect(dto.url).toBe('https://cdn.example.com/voice/abc.m4a?sig=redacted')
    expect(dto.mediaAssetId).toBe('asset-42')
    expect(dto.objectKey).toBe('asset-42')
    expect(dto.urlExpiresAt).toBe('2026-01-01T00:15:00.000Z')
  })

  it('still accepts a legacy durationMs-only payload (old client build)', async () => {
    const dto = plainToInstance(VoiceDto, { durationMs: 1000 })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('rejects a durationMs outside the 1ms..1hour bound', async () => {
    const tooLong = plainToInstance(VoiceDto, { durationMs: 60 * 60 * 1000 + 1 })
    expect((await validate(tooLong)).length).toBeGreaterThan(0)

    const tooShort = plainToInstance(VoiceDto, { durationMs: 0 })
    expect((await validate(tooShort)).length).toBeGreaterThan(0)
  })

  it('rejects a non-string url instead of silently coercing it', async () => {
    const dto = plainToInstance(VoiceDto, { durationMs: 1000, url: 12345 })
    const errors = await validate(dto)
    expect(errors.some((e) => e.property === 'url')).toBe(true)
  })
})
