// src/realtime/handlers/messages.ts

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'

import {
  EVT,
  rooms,
  type Ack,
  type HistoryPayload,
  type SendMessageAck,
  type SendMessagePayload,
  type EditMessagePayload,
  type SocketPrincipal,
  isBroadcastConversation,
} from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'
import { E2eeKeysService } from '../../chat/features/e2ee/e2ee-keys.service'
import {
  validateSocketPayload,
  SendMessageDto,
  EditMessageDto,
  DeleteMessageDto,
  HistoryDto,
} from '../socket-dto'

const logger = new Logger('ChatMessagesHandler')

const USER_SAFE_REVIEW_MESSAGE =
  'This media cannot be sent until it passes KIS family-safety checks.'

function attachmentNeedsSafetyReview(attachment: any): boolean {
  if (!attachment || typeof attachment !== 'object') return false
  const safety = attachment.safety && typeof attachment.safety === 'object' ? attachment.safety : {}
  const status = String(
    attachment.scanStatus ??
      attachment.scan_status ??
      safety.status ??
      '',
  ).trim().toLowerCase()
  return Boolean(
    attachment.quarantined ||
      attachment.requiresReview ||
      attachment.requires_review ||
      safety.quarantined ||
      safety.requiresReview ||
      ['pending_review', 'blocked', 'failed'].includes(status) ||
      (attachment.kind && !attachment.url && !attachment.downloadUrl),
  )
}


function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function urlPathOnly(url?: string) {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url.replace(/https?:\/\/[^/]+/i, '')
  }
}

function pickUpstreamMessage(data: any) {
  if (typeof data?.detail === 'string') return data.detail
  if (typeof data?.message === 'string') return data.message
  if (typeof data?.error === 'string') return data.error
  return undefined
}

function publicErrorDiagnostics(error: any, context: Record<string, any>) {
  const response = error?.response
  const config = error?.config
  const upstreamData = response?.data
  return {
    source: 'nest:chat.messages',
    at: new Date().toISOString(),
    ...context,
    message: error?.message ?? 'Messaging operation failed',
    name: error?.name,
    code: error?.code,
    stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack,
    upstreamStatus: response?.status,
    upstreamStatusText: response?.statusText,
    upstreamPath: urlPathOnly(config?.url),
    upstreamMethod: typeof config?.method === 'string' ? config.method.toUpperCase() : undefined,
    upstreamTimeoutMs: config?.timeout,
    upstreamMessage: pickUpstreamMessage(upstreamData),
    upstreamData,
  }
}

function ackError(error: any, fallback: string, context: Record<string, any>) {
  const diagnostics = publicErrorDiagnostics(error, context)
  return {
    ...err(error?.message ?? fallback, error?.code ?? 'ERROR'),
    diagnostics,
  }
}

function logMessagingError(error: any, context: Record<string, any>) {
  const diagnostics = publicErrorDiagnostics(error, context)
  logger.error(
    `[messages] ${context.event ?? 'chat'} failed diagnostics=${safeJson(diagnostics)}`,
    error?.stack ?? error?.message ?? error,
  )
}

function assertSafeMessageMedia(payload: SendMessagePayload) {
  const legacyAttachments = Array.isArray((payload as any)?.attachments)
    ? (payload as any).attachments
    : []
  const mediaAttachments = Array.isArray((payload as any)?.media?.attachments)
    ? (payload as any).media.attachments
    : []
  const attachments = [...legacyAttachments, ...mediaAttachments]
  const unsafe = attachments.find(attachmentNeedsSafetyReview)
  if (unsafe) {
    logger.warn('[messages] blocked unsafe or unreviewed media attachment', {
      conversationId: payload?.conversationId,
      clientId: payload?.clientId,
      attachmentId: unsafe?.id,
      scanStatus: unsafe?.scanStatus ?? unsafe?.safety?.status,
      quarantined: unsafe?.quarantined ?? unsafe?.safety?.quarantined,
    })
    throw new Error(USER_SAFE_REVIEW_MESSAGE)
  }
}

export interface MessagesDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
    updateLastMessage(args: { conversationId: string; createdAt: Date; preview?: string }): Promise<void>
    listMemberIds?: (conversationId: string) => Promise<string[]>
    getMutedMemberIds?: (conversationId: string) => Promise<string[]>
    policyCheck?: (args: {
      principal: SocketPrincipal
      conversationId: string
      action: 'send' | 'edit' | 'delete'
      text?: string
    }) => Promise<{ allowed: boolean; reason?: string; matches?: string[]; warn?: string[] }>
    dispatchWebhook: (args: {
      conversationId: string
      event: string
      payload?: Record<string, any>
    }) => Promise<{ delivered: number }>
  }
  moderationService?: {
    assertAllowed(args: {
      conversationId: string
      userId: string
      action: 'send' | 'edit' | 'delete'
    }): Promise<void> | void
  }
  djangoSeqClient: {
    allocateSeq(conversationId: string): Promise<number>
    // compatibility alias if your client uses allocate()
    allocate?: (conversationId: string) => Promise<number>
  }
  messagesService: {
    // AND-263: lets the send handler check for an already-persisted
    // message by clientId BEFORE allocating a seq, so a genuine retry
    // (same clientId, e.g. after a socket reconnect resent an unacked
    // send) never wastes a seq allocation at all, rather than discovering
    // the duplicate only after djangoSeqClient.allocateSeq() already
    // incremented Conversation.last_message_seq with no way to undo it.
    findByClientId(conversationId: string, clientId: string): Promise<{
      id: string
      seq: number
      createdAt: Date
    } | null>

    // idempotent create with rich payload
    createIdempotent(args: {
      senderId: string
      senderDeviceId?: string
      conversationId: string
      clientId: string
      seq: number
      input: SendMessagePayload
    }): Promise<{
      id: string
      seq: number
      createdAt: Date
      dto: any
      // True when this clientId was already persisted by an earlier call
      // (a retried/duplicate send) - callers must skip post-send side
      // effects (push notifications, webhook dispatch, etc.) in that case.
      reused?: boolean
    }>

    editMessage(args: {
      senderId: string
      conversationId: string
      messageId: string
      input: EditMessagePayload
    }): Promise<any>

    deleteMessage(args: {
      senderId: string
      conversationId: string
      messageId: string
    }): Promise<any>

    markViewOnceOpened(args: {
      viewerId: string
      conversationId: string
      messageId: string
    }): Promise<any>

    listRecent(args: {
      conversationId: string
      limit?: number
      before?: string
      after?: string
    }): Promise<any[]>

    votePoll(args: {
      conversationId: string
      messageId: string
      optionId: string
      userId: string
    }): Promise<any>
  }
  e2eeKeysService: E2eeKeysService
  notificationsService?: {
    notifyNewMessage(input: {
      toUserId: string
      conversationId: string
      messageId: string
      preview?: string
      senderName?: string
      senderId?: string
    }): Promise<any>
  }
  presenceService?: {
    isOnline(userId: string): Promise<boolean>
  }
}

/**
 * Broadcasts a just-created message to its conversation room. `socket`, when
 * given, also gets a direct self-echo so the sender sees their own message
 * immediately even before their client has joined the room — used by the
 * live EVT.SEND path. The scheduled-delivery cron (scheduled-messages.cron.ts)
 * calls this without a socket, since there is no live sender connection to
 * echo to; the sender picks the message up through the normal room broadcast
 * (if connected) or the next history sync, exactly like a message sent from
 * another of their own devices while this one was offline.
 */
export function broadcastCreatedMessage(
  server: Server,
  conversationId: string,
  createdDto: any,
  socket?: Socket,
) {
  safeEmit(server, rooms.convRoom(conversationId), EVT.MESSAGE, createdDto)
  socket?.emit(EVT.MESSAGE, createdDto)
}

/**
 * Everything that happens after a message is durably persisted: updating the
 * conversation's last-message preview, firing the outbound webhook, fanning
 * out conversation/badge updates to every member's own devices, and pushing
 * to whichever recipients aren't actively viewing the conversation right now.
 * Shared verbatim by the live EVT.SEND handler and the scheduled-message
 * delivery cron so a message's downstream behavior never depends on which of
 * the two triggered it — see ScheduledMessagesCron.deliverOne().
 */
export async function runPostSendSideEffects(
  deps: Pick<MessagesDeps, 'djangoConversationClient' | 'notificationsService'>,
  server: Server,
  args: {
    conversationId: string
    senderId: string
    senderName?: string
    createdId: string
    seq: number
    createdAt: Date
    preview?: string
  },
): Promise<void> {
  const { conversationId, senderId, senderName, createdId, seq, createdAt, preview } = args

  await deps.djangoConversationClient.updateLastMessage({
    conversationId,
    createdAt,
    preview,
  }).catch((e: any) => logger.warn('[messages] updateLastMessage failed', e?.message))

  await deps.djangoConversationClient.dispatchWebhook({
    conversationId,
    event: 'message.created',
    payload: { messageId: createdId, senderId },
  }).catch((e: any) => logger.warn('[messages] dispatchWebhook failed', e?.message))

  if (!deps.djangoConversationClient.listMemberIds) return
  const memberIds = await deps.djangoConversationClient.listMemberIds(conversationId).catch((e: any) => {
    logger.warn('[messages] listMemberIds failed', e?.message)
    return [] as string[]
  })
  // Fetched once per send (not per-recipient) - who has muted THIS
  // conversation. Previously nothing in the push pipeline ever checked
  // per-conversation mute at all, only each recipient's GLOBAL "message
  // notifications" preference and DND hours - muting one chat had zero
  // effect on whether its pushes kept arriving.
  const mutedUserIds = new Set(
    (await deps.djangoConversationClient.getMutedMemberIds?.(conversationId).catch((e: any) => {
      logger.warn('[messages] getMutedMemberIds failed', e?.message)
      return [] as string[]
    })) ?? [],
  )
  for (const userId of memberIds) {
    const convUpdatePayload = {
      event: EVT.CONVERSATION_UPDATED,
      reason: 'message_created',
      conversationId,
      messageId: createdId,
      senderId,
      preview,
      lastMessageAt: createdAt.toISOString(),
      seq,
    }
    safeEmit(server, rooms.userRoom(String(userId)), EVT.CONVERSATION_UPDATED, convUpdatePayload)
    // Also emit conversation.last_message so frontend last-message listeners fire
    safeEmit(server, rooms.userRoom(String(userId)), EVT.CONVERSATION_LAST_MESSAGE, convUpdatePayload)
    safeEmit(server, rooms.userRoom(String(userId)), EVT.MAIN_TAB_BADGES_UPDATED, {
      event: EVT.MAIN_TAB_BADGES_UPDATED,
      source: 'messages',
      reason: 'message_created',
      conversationId,
      userId: String(userId),
      at: new Date().toISOString(),
    })
    if (!deps.notificationsService) continue
    if (String(userId) === String(senderId)) continue
    // Presence.isOnline only reflects "has any live socket to the server" —
    // true even while backgrounded, since iOS/Android keep a socket
    // connection alive for a while after the app leaves the foreground.
    // Room membership is the correct signal: the client explicitly joins
    // this conversation's room only while actively viewing it (chat.join)
    // and leaves it when navigating away or backgrounding (chat.leave).
    const recipientSockets = await server.in(rooms.convRoom(conversationId)).fetchSockets()
    const isActivelyViewing = recipientSockets.some(
      (s: any) => String(s.principal?.userId) === String(userId),
    )
    if (isActivelyViewing) {
      logger.log(`[messages] push skipped: recipient=${userId} is actively viewing conversation=${conversationId}`)
      continue
    }
    if (mutedUserIds.has(String(userId))) {
      logger.log(`[messages] push skipped: recipient=${userId} has muted conversation=${conversationId}`)
      continue
    }
    logger.log(`[messages] sending push: recipient=${userId} conversation=${conversationId} messageId=${createdId}`)
    await deps.notificationsService.notifyNewMessage({
      toUserId: String(userId),
      conversationId,
      messageId: createdId,
      preview,
      senderName,
      senderId,
    }).then((res: any) => logger.log(`[messages] push result recipient=${userId}: ${JSON.stringify(res)}`))
      .catch((e: any) => logger.warn('[messages] notifyNewMessage failed', e?.message))
  }
}

export function registerMessageHandlers(server: Server, socket: Socket, deps: MessagesDeps) {
  socket.on(EVT.SEND, async (payload: SendMessagePayload, ack?: (a: Ack<{ ack: SendMessageAck }>) => void) => {
    const principal = getPrincipal(socket)

    const validation = await validateSocketPayload(SendMessageDto, payload)
    if (!validation.ok) {
      return safeAck(ack, err(validation.errors.join('; '), 'BAD_REQUEST'))
    }

    const conversationId = payload?.conversationId
    const clientId = payload?.clientId

    const textPreview =
      typeof payload?.text === 'string' ? payload.text.slice(0, 120) : undefined
    logger.log(`[messages] incoming send payload`, {
      conversationId,
      clientId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      kind: payload?.kind,
      text: textPreview,
    })

    let stage = 'send.start'
    try {
      const hasEncryptedPayload = !!(
        payload?.ciphertext ||
        payload?.encryptionMeta ||
        payload?.encrypted
      )

      // AND-263: a genuine retry (same clientId — e.g. the client resent
      // an unacked message after a socket reconnect) used to still run
      // djangoSeqClient.allocateSeq() below, which atomically and
      // PERMANENTLY increments Conversation.last_message_seq server-side,
      // before createIdempotent's own dedupe check ever got a chance to
      // say "this message already exists." That orphaned seq gap directly
      // inflated every recipient's unread badge count (badge_counts.py:
      // last_message_seq - last_read_seq) by one for every retried send,
      // with no way to ever correct it after the fact. Checking here,
      // before any of that, means a real retry costs nothing - no wasted
      // seq, no duplicate broadcast, no duplicate push/webhook dispatch.
      if (clientId) {
        stage = 'send.check_duplicate'
        const existing = await deps.messagesService.findByClientId(conversationId, clientId)
        if (existing) {
          safeAck(ack, ok({
            ack: {
              clientId,
              serverId: existing.id,
              seq: existing.seq,
              createdAt: existing.createdAt.toISOString(),
            },
          }))
          return
        }
      }

      stage = 'send.rate_limit'
      await deps.rateLimitService.assert(principal, `send:${conversationId}`, 50)
      stage = 'send.assert_member'
      const perms = await deps.djangoConversationClient.assertMember(principal, conversationId)
      stage = 'send.media_safety'
      assertSafeMessageMedia(payload)

      logger.log('[messages] perms result', perms)

      const canSend =
        perms?.isMember === true &&
        perms?.isBlocked !== true &&
        perms?.canSend !== false
      if (!canSend) {
        throw new Error('Send not allowed in this conversation')
      }
      // Nest's own per-conversation self-block/self-mute (Mongo
      // ConversationBlock/ConversationMute, "mute/block this chat for
      // myself") was already enforced for edit/delete/typing/receipts/
      // reactions but never for the send path itself - the one action
      // this whole feature exists to gate. See moderationService.assertAllowed.
      if (deps.moderationService) {
        stage = 'send.moderation'
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'send',
        })
      }
      if (deps.djangoConversationClient.policyCheck) {
        stage = 'send.policy_check'
        const policy = await deps.djangoConversationClient.policyCheck({
          principal,
          conversationId,
          action: 'send',
          text: hasEncryptedPayload ? undefined : (payload?.text ?? ''),
        })
        if (policy?.allowed === false) {
          throw new Error(policy.reason || 'Policy blocked this message')
        }
      }

      stage = 'send.allocate_seq'
      const seq = deps.djangoSeqClient.allocateSeq
        ? await deps.djangoSeqClient.allocateSeq(conversationId)
        : deps.djangoSeqClient.allocate
        ? await deps.djangoSeqClient.allocate(conversationId)
        : (() => {
            throw new Error('Seq allocator not configured')
          })()

      stage = 'send.persist_message'
      const created = await deps.messagesService.createIdempotent({
        senderId: principal.userId,
        senderDeviceId: principal.deviceId,
        conversationId,
        clientId,
        seq,
        input: payload,
      })

      const createdConvId =
        (created as any)?.dto?.conversationId ?? (created as any)?.conversationId
      if (createdConvId && String(createdConvId) !== String(conversationId)) {
        throw new Error('Conversation mismatch on create')
      }

      const createdDto = created.dto ?? created
      const isBroadcastConv = isBroadcastConversation(conversationId)
      logger.log(
        `[messages] send conversation=${conversationId} broadcast=${isBroadcastConv} clientId=${clientId} serverId=${created.id}`,
      )
      const ackPayload: SendMessageAck = {
        clientId,
        serverId: created.id,
        seq: created.seq,
        createdAt: created.createdAt.toISOString(),
      }

      // Broadcast first so clients see the new message immediately
      broadcastCreatedMessage(server, conversationId, createdDto, socket)
      safeAck(ack, ok({ ack: ackPayload }))

      if (created.reused) {
        // This clientId was already persisted by an earlier call (e.g. the
        // client resent EVT.SEND after a socket reconnect because it never
        // received the first ack) - updateLastMessage/dispatchWebhook/
        // notifyNewMessage already ran once for this message. Re-running them
        // would dispatch a duplicate outbound webhook and a duplicate push.
        logger.log(`[messages] skipping post-send side effects for reused clientId=${clientId} serverId=${created.id}`)
      } else {
        const preview = createdDto?.previewText ?? payload?.previewText ?? (hasEncryptedPayload
          ? 'Encrypted message'
          : (createdDto?.text ?? payload?.text))
        runPostSendSideEffects(
          { djangoConversationClient: deps.djangoConversationClient, notificationsService: deps.notificationsService },
          server,
          {
            conversationId,
            senderId: principal.userId,
            senderName: principal.username ?? undefined,
            createdId: created.id,
            seq: created.seq,
            createdAt: created.createdAt,
            preview,
          },
        ).catch((e: any) =>
          logger.error('[messages] post-send side effects failed', e?.stack ?? e?.message),
        )
      }
    } catch (e: any) {
      const context = {
        event: EVT.SEND,
        stage,
        conversationId,
        clientId,
        userId: principal?.userId,
        deviceId: principal?.deviceId,
      }
      logMessagingError(e, context)
      safeAck(ack, ackError(e, 'Send failed', context))
    }
  })

  socket.on(EVT.EDIT, async (payload: EditMessagePayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)

    const validation = await validateSocketPayload(EditMessageDto, payload)
    if (!validation.ok) {
      return safeAck(ack, err(validation.errors.join('; '), 'BAD_REQUEST'))
    }

    const conversationId = payload?.conversationId
    const messageId = payload?.messageId

    let stage = 'edit.start'
    try {
      stage = 'edit.rate_limit'
      await deps.rateLimitService.assert(principal, `edit:${conversationId}`, 60)
      stage = 'edit.assert_member'
      const perms = await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (perms?.canSend === false) {
        throw new Error('Edit not allowed in this conversation')
      }
      if (deps.moderationService) {
        stage = 'edit.moderation'
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'edit',
        })
      }
      if (deps.djangoConversationClient.policyCheck) {
        const hasEncryptedPayload = !!(
          payload?.ciphertext ||
          payload?.encryptionMeta ||
          payload?.encrypted
        )
        stage = 'edit.policy_check'
        const policy = await deps.djangoConversationClient.policyCheck({
          principal,
          conversationId,
          action: 'edit',
          text: hasEncryptedPayload ? undefined : (payload?.text ?? ''),
        })
        if (policy?.allowed === false) {
          throw new Error(policy.reason || 'Policy blocked this edit')
        }
      }

      stage = 'edit.persist_message'
      const updated = await deps.messagesService.editMessage({
        senderId: principal.userId,
        conversationId,
        messageId,
        input: payload,
      })

      const updatedConvId = (updated as any)?.conversationId
      if (updatedConvId && String(updatedConvId) !== String(conversationId)) {
        throw new Error('Conversation mismatch on edit')
      }

      safeEmit(server, rooms.convRoom(conversationId), EVT.EDIT, updated)
      try {
        await deps.djangoConversationClient.dispatchWebhook({
          conversationId,
          event: 'message.edited',
          payload: {
            messageId,
            senderId: principal.userId,
          },
        })
      } catch {}
      safeAck(ack, ok({ updated: true }))
    } catch (e: any) {
      const context = {
        event: EVT.EDIT,
        stage,
        conversationId,
        messageId,
        userId: principal?.userId,
        deviceId: principal?.deviceId,
      }
      logMessagingError(e, context)
      safeAck(ack, ackError(e, 'Edit failed', context))
    }
  })

  socket.on(EVT.DELETE, async (payload: { conversationId: string; messageId: string }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)

    const validation = await validateSocketPayload(DeleteMessageDto, payload)
    if (!validation.ok) {
      return safeAck(ack, err(validation.errors.join('; '), 'BAD_REQUEST'))
    }

    const conversationId = payload?.conversationId
    const messageId = payload?.messageId

    let stage = 'delete.start'
    try {
      stage = 'delete.rate_limit'
      await deps.rateLimitService.assert(principal, `delete:${conversationId}`, 60)
      stage = 'delete.assert_member'
      const perms = await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (perms?.canSend === false) {
        throw new Error('Delete not allowed in this conversation')
      }
      if (deps.moderationService) {
        stage = 'delete.moderation'
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'delete',
        })
      }
      if (deps.djangoConversationClient.policyCheck) {
        stage = 'delete.policy_check'
        const policy = await deps.djangoConversationClient.policyCheck({
          principal,
          conversationId,
          action: 'delete',
        })
        if (policy?.allowed === false) {
          throw new Error(policy.reason || 'Policy blocked this delete')
        }
      }

      stage = 'delete.persist_message'
      const deleted = await deps.messagesService.deleteMessage({
        senderId: principal.userId,
        conversationId,
        messageId,
      })

      const deletedConvId = (deleted as any)?.conversationId
      if (deletedConvId && String(deletedConvId) !== String(conversationId)) {
        throw new Error('Conversation mismatch on delete')
      }

      safeEmit(server, rooms.convRoom(conversationId), EVT.DELETE, deleted)
      try {
        await deps.djangoConversationClient.dispatchWebhook({
          conversationId,
          event: 'message.deleted',
          payload: {
            messageId,
            senderId: principal.userId,
          },
        })
      } catch {}
      safeAck(ack, ok({ deleted: true }))
    } catch (e: any) {
      const context = {
        event: EVT.DELETE,
        stage,
        conversationId,
        messageId,
        userId: principal?.userId,
        deviceId: principal?.deviceId,
      }
      logMessagingError(e, context)
      safeAck(ack, ackError(e, 'Delete failed', context))
    }
  })

  socket.on(EVT.LOCATION_UPDATE, async (payload: any, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { conversationId, messageId, latitude, longitude, address, expiresAt } = payload || {}

    if (!conversationId || !messageId || latitude == null || longitude == null) {
      return safeAck(ack, err('conversationId, messageId, latitude, longitude required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `location_update:${conversationId}`, 120)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      safeEmit(server, rooms.convRoom(conversationId), EVT.LOCATION_UPDATE, {
        conversationId,
        messageId,
        latitude,
        longitude,
        address,
        expiresAt,
        userId: principal.userId,
        at: Date.now(),
      })
      safeAck(ack, ok({ ok: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Location update failed', 'ERROR'))
    }
  })

  socket.on(EVT.VIEW_ONCE, async (payload: { conversationId: string; messageId: string }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { conversationId, messageId } = payload || {}

    if (!conversationId || !messageId) {
      return safeAck(ack, err('conversationId and messageId are required', 'BAD_REQUEST'))
    }

    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      // Strips the content and records it as opened - NOT a delete-for-
      // everyone (that's EVT.DELETE/deleteMessage, a different action with
      // a different permission model and a different client-rendered
      // terminal state - see markViewOnceOpened's docstring for why this
      // used to call that by mistake).
      const opened = await deps.messagesService.markViewOnceOpened({
        viewerId: principal.userId,
        conversationId,
        messageId,
      })

      // Broadcast to the whole room (including the opener's own other
      // devices) so every participant's client applies the same "Opened"
      // state instead of only the opener's own optimistic local strip.
      safeEmit(server, rooms.convRoom(conversationId), EVT.VIEW_ONCE, opened ?? { conversationId, messageId })

      safeAck(ack, ok({ viewed: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'View-once acknowledgement failed', 'ERROR'))
    }
  })

  socket.on(EVT.HISTORY, async (payload: HistoryPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)

    const validation = await validateSocketPayload(HistoryDto, payload)
    if (!validation.ok) {
      return safeAck(ack, err(validation.errors.join('; '), 'BAD_REQUEST'))
    }

    const conversationId = payload?.conversationId

    let stage = 'history.start'
    try {
      stage = 'history.rate_limit'
      await deps.rateLimitService.assert(principal, `history:${conversationId}`, 120)
      stage = 'history.assert_member'
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      stage = 'history.list_recent'
      const items = await deps.messagesService.listRecent({
        conversationId,
        limit: payload?.limit,
        before: payload?.before,
        after: payload?.after,
      })

      safeAck(ack, ok({ messages: items }))
    } catch (e: any) {
      const context = {
        event: EVT.HISTORY,
        stage,
        conversationId,
        userId: principal?.userId,
        deviceId: principal?.deviceId,
      }
      logMessagingError(e, context)
      safeAck(ack, ackError(e, 'History failed', context))
    }
  })
}
