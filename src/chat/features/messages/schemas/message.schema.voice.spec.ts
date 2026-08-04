import { MessageSchema } from './message.schema'

// Regression test for the voice-note root cause: Mongoose subdocument
// casting silently strips any field not declared on the subdocument's own
// schema, independent of what a DTO/controller validates. VoiceMeta
// previously declared ONLY durationMs, so `voice.url` (and everything else)
// was discarded the instant a message document was constructed/saved — the
// receiver, who only ever reads the persisted document back, always got an
// unplayable voice note. This test asserts directly against the compiled
// Mongoose schema (not just class-validator DTOs), because a DTO can be
// perfectly valid and still get silently gutted at the persistence layer.
describe('MessageSchema voice subdocument', () => {
  const voicePath = MessageSchema.path('voice') as any

  it('declares every canonical VoiceAttachment field on the subdocument schema', () => {
    const voiceSchema = voicePath.schema
    const declaredPaths = Object.keys(voiceSchema.paths)

    for (const field of ['durationMs', 'id', 'url', 'mediaAssetId', 'objectKey', 'originalName', 'mimeType', 'size', 'waveform', 'urlExpiresAt']) {
      expect(declaredPaths).toContain(field)
    }
  })

  it('a Message constructed with a full voice payload keeps voice.url and voice.mediaAssetId after Mongoose casting', () => {
    const mongoose = require('mongoose')
    const TestModel =
      mongoose.models.__VoiceCastingTestMessage || mongoose.model('__VoiceCastingTestMessage', MessageSchema)

    const doc = new TestModel({
      conversationId: 'conv-1',
      senderId: 'user-1',
      kind: 'voice',
      voice: {
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
      },
    })

    // toObject() runs the same cast Mongoose applies before a real save —
    // this is exactly the point at which the bug silently dropped fields.
    const plain = doc.toObject()
    expect(plain.voice.durationMs).toBe(4200)
    expect(plain.voice.url).toBe('https://cdn.example.com/voice/abc.m4a?sig=redacted')
    expect(plain.voice.mediaAssetId).toBe('asset-42')
    expect(plain.voice.objectKey).toBe('asset-42')
    expect(plain.voice.id).toBe('upload-1')
    expect(plain.voice.mimeType).toBe('audio/mp4')
    expect(plain.voice.size).toBe(51200)
    expect(plain.voice.waveform).toEqual([1, 2, 3])
    expect(plain.voice.urlExpiresAt).toBe('2026-01-01T00:15:00.000Z')
  })

  it('still accepts a legacy durationMs-only voice payload (backward compatibility)', () => {
    const mongoose = require('mongoose')
    const TestModel =
      mongoose.models.__VoiceCastingTestMessage || mongoose.model('__VoiceCastingTestMessage', MessageSchema)

    const doc = new TestModel({
      conversationId: 'conv-1',
      senderId: 'user-1',
      kind: 'voice',
      voice: { durationMs: 1000 },
    })

    const plain = doc.toObject()
    expect(plain.voice.durationMs).toBe(1000)
    expect(plain.voice.url).toBeUndefined()
  })
})
