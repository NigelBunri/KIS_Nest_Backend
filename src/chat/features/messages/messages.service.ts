// src/chat/features/messages/messages.service.ts

import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import { Message, MessageDocument, MessageKind } from './schemas/message.schema'
import { SendMessageDto } from './messages.dto'
import type { SendMessagePayload, EditMessagePayload } from '../../chat.types'

@Injectable()
export class MessagesService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
  ) {}

  /**
   * ✅ Legacy implementation (your DB write path)
   */
  async createIdempotentLegacy(params: {
    senderId: string
    senderDeviceId?: string
    senderName?: string
    seq: number
    input: SendMessageDto
  }): Promise<MessageDocument> {
    const { senderId, senderDeviceId, seq, input } = params

    this.assertKindPayloadConsistency(input)

    const existing = await this.messageModel.findOne({
      conversationId: input.conversationId,
      clientId: input.clientId,
    })
    if (existing) return existing

    const previewText = this.buildPreview(input)
    const created = new this.messageModel({
      conversationId: input.conversationId,
      senderId,
      clientId: input.clientId,
      seq,

      kind: input.kind as unknown as MessageKind,

      threadId: input.threadId,

      senderDeviceId,
      text: input.text,
      ciphertext: input.ciphertext,
      encryptionMeta: input.encryptionMeta,
      iv: input.iv,
      tag: input.tag,
      aad: input.aad,
      encryptionVersion: input.encryptionVersion,
      encryptionKeyVersion: input.encryptionKeyVersion,
      styledText: input.styledText,
      voice: input.voice,
      sticker: input.sticker,

      attachments: input.attachments,
      media: (input as any).media,
      contacts: input.contacts,
      poll: input.poll,
      event: input.event,
      location: (input as any).location,
      linkPreview: (input as any).linkPreview,

      replyToId: input.replyToId,

      callEvent: (input as any).callEvent,

      previewText,
    })

    try {
      return await created.save()
    } catch (e: any) {
      if (e?.code === 11000) {
        const again = await this.messageModel.findOne({
          conversationId: input.conversationId,
          clientId: input.clientId,
        })
        if (again) return again
      }
      throw e
    }
  }

  /**
   * ✅ Handler-compatible createIdempotent (used by realtime handlers)
   * This wraps your legacy persistence method and returns what the handlers expect.
   */
  async createIdempotent(args: {
    senderId: string
    senderDeviceId?: string
    conversationId: string
    clientId: string
    seq: number
    input: SendMessagePayload
  }): Promise<{ id: string; seq: number; createdAt: Date; dto: any }> {
    // Convert payload into legacy DTO shape.
    // Most fields already match names; keep as any for now to unblock compile.
    const rawMedia = (args.input as any).media && typeof (args.input as any).media === 'object'
      ? (args.input as any).media
      : undefined
    const mediaAttachments = Array.isArray(rawMedia?.attachments)
      ? this.normalizeAttachments(rawMedia.attachments)
      : undefined
    const legacyInput: SendMessageDto = {
      ...(args.input as any),
      conversationId: args.conversationId,
      clientId: args.clientId,
      // your schema expects replyToId (frontend uses replyTo)
      replyToId: (args.input as any).replyToId ?? (args.input as any).replyTo,
      attachments: this.normalizeAttachments((args.input as any).attachments),
      media: rawMedia ? { ...rawMedia, attachments: mediaAttachments ?? [] } : undefined,
    }

    const doc = await this.createIdempotentLegacy({
      senderId: args.senderId,
      senderDeviceId: args.senderDeviceId,
      seq: args.seq,
      input: legacyInput,
    })

    const id = (doc as any).id ?? (doc as any)._id?.toString?.() ?? String((doc as any)._id)
    const createdAt = (doc as any).createdAt ?? new Date()

    // If you have a mapper, plug it here. For now, emit doc as DTO.
    const dto = doc

    return { id, seq: args.seq, createdAt, dto }
  }

  /* ==========================================================================
   * COMPAT WRAPPER (older gateway calls)
   * ========================================================================== */

  async sendIdempotent(input: any) {
    const { senderId, seq, ...rest } = input
    return this.createIdempotentLegacy({
      senderId,
      seq,
      input: rest,
    } as any)
  }

  /* ==========================================================================
   * EDIT + DELETE (Handler-compatible wrappers)
   * ========================================================================== */

  /**
   * ✅ Handlers expect:
   * editMessage({ senderId, conversationId, messageId, input })
   */
  async editMessage(args: {
    senderId: string
    conversationId: string
    messageId: string
    input: EditMessagePayload
  }): Promise<MessageDocument> {
    return this.editMessageLegacy({
      conversationId: args.conversationId,
      messageId: args.messageId,
      editorId: args.senderId,
      text: args.input.text,
      ciphertext: (args.input as any).ciphertext,
      encryptionMeta: (args.input as any).encryptionMeta,
      iv: (args.input as any).iv,
      tag: (args.input as any).tag,
      aad: (args.input as any).aad,
      encryptionVersion: (args.input as any).encryptionVersion,
      encryptionKeyVersion: (args.input as any).encryptionKeyVersion,
      // if later you support styledText edits, map it here
      // styledText: (args.input as any).styledText,
    })
  }

  /**
   * Your existing edit logic (kept as-is, renamed)
   */
  async editMessageLegacy(input: {
    conversationId: string
    messageId: string
    editorId: string
    editorDeviceId?: string
    ciphertext?: string
    encryptionMeta?: Record<string, any>
    iv?: string
    tag?: string
    aad?: string
    encryptionVersion?: string
    encryptionKeyVersion?: string
    text?: string
    attachments?: any[]
    nowMs?: number
  }): Promise<MessageDocument> {
    const nowMs = input.nowMs ?? Date.now()

    const msg = await this.messageModel.findOne({
      _id: input.messageId,
      conversationId: input.conversationId,
    })

    if (!msg) throw new NotFoundException('message not found')
    if (String(msg.senderId) !== String(input.editorId)) {
      throw new ForbiddenException('only sender can edit')
    }
    if ((msg as any).isDeleted) throw new BadRequestException('cannot edit deleted message')
    const EDIT_WINDOW_MS = 15 * 60 * 1000
    const msgCreatedAt = (msg as any).createdAt
    if (msgCreatedAt) {
      const age = nowMs - (msgCreatedAt instanceof Date ? msgCreatedAt.getTime() : Number(msgCreatedAt))
      if (age > EDIT_WINDOW_MS) throw new BadRequestException('messages can only be edited within 15 minutes of sending')
    }

    if (typeof input.text === 'string') (msg as any).text = input.text
    if (Array.isArray(input.attachments)) (msg as any).attachments = input.attachments as any

    if (typeof input.ciphertext === 'string') (msg as any).ciphertext = input.ciphertext
    if (input.encryptionMeta && typeof input.encryptionMeta === 'object') (msg as any).encryptionMeta = input.encryptionMeta
    if (typeof input.iv === 'string') (msg as any).iv = input.iv
    if (typeof input.tag === 'string') (msg as any).tag = input.tag
    if (typeof input.aad === 'string') (msg as any).aad = input.aad
    if (typeof input.encryptionVersion === 'string') (msg as any).encryptionVersion = input.encryptionVersion
    if (typeof input.encryptionKeyVersion === 'string') (msg as any).encryptionKeyVersion = input.encryptionKeyVersion

    ;(msg as any).isEdited = true
    ;(msg as any).editedAt = nowMs

    ;(msg as any).previewText = this.buildPreview({
      conversationId: (msg as any).conversationId,
      clientId: (msg as any).clientId,
      kind: (msg as any).kind,
      text: (msg as any).text,
      styledText: (msg as any).styledText,
      voice: (msg as any).voice,
      sticker: (msg as any).sticker,
      attachments: (msg as any).attachments,
      media: (msg as any).media,
      contacts: (msg as any).contacts,
      poll: (msg as any).poll,
      event: (msg as any).event,
      replyToId: (msg as any).replyToId,
    } as any)

    await (msg as any).save()
    return msg
  }

  /**
   * ✅ Handlers expect:
   * deleteMessage({ senderId, conversationId, messageId })
   */
  async deleteMessage(args: {
    senderId: string
    conversationId: string
    messageId: string
  }): Promise<MessageDocument> {
    // default to "deleted_for_everyone" or "deleted_for_me"
    // Here we keep conservative: delete for everyone only if sender.
    return this.deleteMessageLegacy({
      conversationId: args.conversationId,
      messageId: args.messageId,
      requesterId: args.senderId,
      mode: 'deleted_for_everyone',
    })
  }

  async deleteMessageLegacy(input: {
    conversationId: string
    messageId: string
    requesterId: string
    mode: 'deleted_for_me' | 'deleted_for_everyone'
    nowMs?: number
  }): Promise<MessageDocument> {
    const nowMs = input.nowMs ?? Date.now()

    const msg = await this.messageModel.findOne({
      _id: input.messageId,
      conversationId: input.conversationId,
    })

    if (!msg) throw new NotFoundException('message not found')

    if (input.mode === 'deleted_for_everyone') {
      if (String((msg as any).senderId) !== String(input.requesterId)) {
        throw new ForbiddenException('only sender can delete for everyone')
      }
      ;(msg as any).isDeleted = true
    }

    ;(msg as any).deleteState = input.mode
    ;(msg as any).deletedAt = nowMs
    ;(msg as any).deletedBy = input.requesterId

    await (msg as any).save()
    return msg
  }

  /* ==========================================================================
   * SYNC HELPERS (handler contract)
   * ========================================================================== */

  /**
   * ✅ Handlers expect: getRange({ conversationId, seqs })
   */
  async getRange(args: { conversationId: string; seqs: number[] }): Promise<any[]> {
    if (!args.seqs?.length) return []
    const min = Math.min(...args.seqs)
    const max = Math.max(...args.seqs)
    return this.messageModel
      .find({ conversationId: args.conversationId, seq: { $gte: min, $lte: max } })
      .sort({ seq: 1 })
      .lean()
      .exec()
  }

  async listRecent(args: { conversationId: string; limit?: number; before?: string; after?: string }): Promise<any[]> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500)
    const query: any = { conversationId: args.conversationId }
    if (args.before) {
      const dt = new Date(args.before)
      if (!isNaN(dt.getTime())) query.createdAt = { $lt: dt }
    }
    if (args.after) {
      const dt = new Date(args.after)
      if (!isNaN(dt.getTime())) {
        query.createdAt = query.createdAt ? { ...query.createdAt, $gt: dt } : { $gt: dt }
      }
    }

    const rows = await this.messageModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()

    // .lean() strips the Mongoose `id` virtual (string form of _id).
    // Without it, the frontend receives an ObjectId object instead of a
    // string, which breaks key-based merging against locally-cached messages
    // and causes every history message to appear as a new (encrypted) entry.
    return rows.reverse().map((row) => {
      const idStr = row._id?.toString?.() ?? String(row._id ?? '');
      return { ...row, _id: idStr, id: idStr };
    });
  }

  async listRecentForConversations(args: {
    conversationIds: string[]
    limit?: number
    since?: Date
  }): Promise<any[]> {
    const ids = Array.isArray(args.conversationIds)
      ? args.conversationIds.map((id) => String(id)).filter(Boolean)
      : []
    if (!ids.length) return []

    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500)
    const query: any = {
      conversationId: { $in: ids },
      isDeleted: { $ne: true },
    }
    if (args.since instanceof Date && !isNaN(args.since.getTime())) {
      query.createdAt = { $gte: args.since }
    }

    return this.messageModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()
  }

  async listByIds(args: { messageIds: string[]; conversationId?: string }): Promise<any[]> {
    const ids = Array.isArray(args.messageIds)
      ? args.messageIds.map((id) => String(id)).filter(Boolean)
      : []
    if (!ids.length) return []

    const query: any = { _id: { $in: ids }, isDeleted: { $ne: true } }
    if (args.conversationId) {
      query.conversationId = String(args.conversationId)
    }

    return this.messageModel
      .find(query)
      .lean()
      .exec()
  }

  /**
   * ✅ Handlers expect: findMissingSeqs({ conversationId, haveSeqs })
   * We'll compute missing between min(have) and max(have).
   */
  async findMissingSeqs(args: { conversationId: string; haveSeqs: number[] }): Promise<number[]> {
    const have = Array.isArray(args.haveSeqs) ? args.haveSeqs.filter((n) => Number.isFinite(n)) : []
    if (!have.length) return []

    const fromSeq = Math.min(...have)
    const toSeq = Math.max(...have)

    const docs = await this.messageModel
      .find({ conversationId: args.conversationId, seq: { $gte: fromSeq, $lte: toSeq } }, { seq: 1 })
      .lean()
      .exec()

    const seen = new Set<number>((docs as any[]).map((d) => d.seq))
    const missing: number[] = []
    for (let s = fromSeq; s <= toSeq; s++) if (!seen.has(s)) missing.push(s)
    return missing
  }

  /* ==========================================================================
   * VALIDATION + PREVIEW
   * ========================================================================== */

  private assertKindPayloadConsistency(input: SendMessageDto) {
    const kind = input.kind as any
    const hasEncryptedPayload = !!((input as any).ciphertext || (input as any).encryptionMeta)

    const allowedKinds = new Set([
      'text',
      'attachment',
      'styled_text',
      'voice',
      'sticker',
      'contacts',
      'poll',
      'event',
      'location',
      'system',
      'call_event',
    ])
    if (!allowedKinds.has(kind)) throw new BadRequestException(`Unsupported kind: ${String(kind)}`)
    if (hasEncryptedPayload) return

    const hasText = !!(input.text && input.text.trim().length)
    const hasStyled = !!input.styledText
    const hasVoice = !!input.voice
    const hasSticker = !!input.sticker
    const mediaAttachments = Array.isArray((input as any).media?.attachments)
      ? (input as any).media.attachments
      : []
    const hasAttachments = !!((input.attachments && input.attachments.length) || mediaAttachments.length)
    const hasContacts = !!(input.contacts && input.contacts.length)
    const hasPoll = !!input.poll
    const hasEvent = !!input.event
    const hasLocation = !!(input as any).location

    switch (kind) {
      case 'text':
        if (!hasText && !hasAttachments) throw new BadRequestException('text messages require text or attachments')
        break
      case 'attachment':
        if (!hasAttachments) throw new BadRequestException('attachment messages require media.attachments')
        break
      case 'styled_text':
        if (!hasStyled) throw new BadRequestException('styled_text requires styledText payload')
        break
      case 'voice':
        if (!hasVoice) throw new BadRequestException('voice requires voice payload')
        break
      case 'sticker':
        if (!hasSticker) throw new BadRequestException('sticker requires sticker payload')
        break
      case 'contacts':
        if (!hasContacts) throw new BadRequestException('contacts requires contacts[] payload')
        break
      case 'poll':
        if (!hasPoll) throw new BadRequestException('poll requires poll payload')
        break
      case 'event':
        if (!hasEvent) throw new BadRequestException('event requires event payload')
        break
      case 'location':
        if (!hasLocation) throw new BadRequestException('location requires location payload')
        break
      case 'system':
        if (!hasText) throw new BadRequestException('system requires text')
        break
      case 'call_event':
        // No payload constraint — callEvent field is set directly on the doc.
        break
    }

    if (kind !== 'styled_text' && hasStyled) throw new BadRequestException('styledText payload only allowed for styled_text kind')
    if (kind !== 'voice' && hasVoice) throw new BadRequestException('voice payload only allowed for voice kind')
    if (kind !== 'sticker' && hasSticker) throw new BadRequestException('sticker payload only allowed for sticker kind')
    if (kind !== 'contacts' && hasContacts) throw new BadRequestException('contacts payload only allowed for contacts kind')
    if (kind !== 'poll' && hasPoll) throw new BadRequestException('poll payload only allowed for poll kind')
    if (kind !== 'event' && hasEvent) throw new BadRequestException('event payload only allowed for event kind')
    if (kind !== 'location' && hasLocation) throw new BadRequestException('location payload only allowed for location kind')
  }

  private buildPreview(input: SendMessageDto): string | undefined {
    if (input.ciphertext || input.encryptionMeta || input.encrypted) {
      return 'Encrypted message'
    }
    const explicitPreview = typeof input.previewText === 'string'
      ? input.previewText.trim().slice(0, 200)
      : ''
    if (explicitPreview) return explicitPreview
    switch (input.kind) {
      case 'text':
        return input.text?.slice(0, 200) ?? (Array.isArray((input as any).media?.attachments) ? 'Attachment' : undefined)
      case 'attachment': {
        const first = Array.isArray((input as any).media?.attachments)
          ? (input as any).media.attachments[0]
          : input.attachments?.[0]
        return first?.originalName ?? first?.name ?? 'Attachment'
      }
      case 'styled_text':
        return input.styledText?.text?.slice(0, 200)
      case 'voice':
        return '🎤 Voice message'
      case 'sticker':
        return 'Sticker'
      case 'contacts':
        return `👤 Contact${((input.contacts?.length ?? 0) > 1 ? 's' : '')}`
      case 'poll':
        return `📊 ${input.poll?.question ?? 'Poll'}`
      case 'event':
        return `📅 ${input.event?.title ?? 'Event'}`
      case 'location':
        return `📍 ${(input as any).location?.title ?? (input as any).location?.address ?? 'Location'}`
      case 'system':
        return input.text?.slice(0, 200)
      case 'call_event':
        return (input as any).callEvent?.status === 'missed' ? '📵 Missed call' : '📞 Call ended'
      default:
        return undefined
    }
  }

  /* ==========================================================================
   * POLL VOTING
   * ========================================================================== */

  async votePoll(args: {
    conversationId: string
    messageId: string
    optionId: string
    userId: string
  }): Promise<MessageDocument> {
    const msg = await this.messageModel.findOne({
      _id: args.messageId,
      conversationId: args.conversationId,
    })

    if (!msg) throw new NotFoundException('message not found')
    if ((msg as any).kind !== 'poll') throw new BadRequestException('message is not a poll')
    if ((msg as any).isDeleted) throw new BadRequestException('cannot vote on deleted message')

    const poll = (msg as any).poll
    if (!poll || !Array.isArray(poll.options)) throw new BadRequestException('poll data missing')

    // Remove existing vote from any option first (de-vote + re-vote support)
    for (const opt of poll.options) {
      if (Array.isArray(opt.voters)) {
        opt.voters = opt.voters.filter((v: string) => v !== args.userId)
        opt.votes = opt.voters.length
      }
    }

    // Cast vote on the target option
    const target = poll.options.find((o: any) => o.id === args.optionId)
    if (!target) throw new BadRequestException(`option ${args.optionId} not found in poll`)
    if (!Array.isArray(target.voters)) target.voters = []
    if (!target.voters.includes(args.userId)) {
      target.voters.push(args.userId)
    }
    target.votes = target.voters.length

    ;(msg as any).markModified('poll')
    await (msg as any).save()
    return msg
  }

  private normalizeAttachments(input: any): any[] | undefined {
    if (!Array.isArray(input) || !input.length) return undefined

    return input.map((a: any) => ({
      id: a.id,
      url: a.url,
      originalName: a.originalName ?? a.name ?? a.filename,
      mimeType: a.mimeType ?? a.mime,
      size: a.size,
      kind: a.kind,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      thumbUrl: a.thumbUrl,
      expiresAt: a.expiresAt ?? undefined,
      expired: a.expired ?? false,
      viewOnce: a.viewOnce ?? false,
      viewedAt: a.viewedAt ?? undefined,
    }))
  }
}
