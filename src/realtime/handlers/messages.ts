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

      // Intercept scheduled messages — persist but do not broadcast yet
      if (payload.scheduledAt) {
        const scheduledDate = new Date(payload.scheduledAt)
        const tenSecondsFromNow = new Date(Date.now() + 10_000)
        if (!isNaN(scheduledDate.getTime()) && scheduledDate > tenSecondsFromNow) {
          safeAck(ack, ok({ ack: { ...ackPayload, scheduled: true, scheduledAt: scheduledDate.toISOString() } }))
          return
        }
      }

      // Broadcast first so clients see the new message immediately
      safeEmit(server, rooms.convRoom(conversationId), EVT.MESSAGE, createdDto)
      socket.emit(EVT.MESSAGE, createdDto)
      safeAck(ack, ok({ ack: ackPayload }))

      const _postSendSideEffects = async () => {
        const preview = createdDto?.previewText ?? payload?.previewText ?? (hasEncryptedPayload
          ? 'Encrypted message'
          : (createdDto?.text ?? payload?.text))

        await deps.djangoConversationClient.updateLastMessage({
          conversationId,
          createdAt: created.createdAt,
          preview,
        }).catch((e: any) => logger.warn('[messages] updateLastMessage failed', e?.message))

        await deps.djangoConversationClient.dispatchWebhook({
          conversationId,
          event: 'message.created',
          payload: { messageId: created.id, senderId: principal.userId },
        }).catch((e: any) => logger.warn('[messages] dispatchWebhook failed', e?.message))

        // Call via the object to preserve `this` context inside listMemberIds
        if (deps.djangoConversationClient.listMemberIds) {
          const memberIds = await deps.djangoConversationClient.listMemberIds(conversationId).catch((e: any) => {
            logger.warn('[messages] listMemberIds failed', e?.message)
            return [] as string[]
          })
          for (const userId of memberIds) {
            const convUpdatePayload = {
              event: EVT.CONVERSATION_UPDATED,
              reason: 'message_created',
              conversationId,
              messageId: created.id,
              senderId: principal.userId,
              preview,
              lastMessageAt: created.createdAt.toISOString(),
              seq: created.seq,
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
            if (String(userId) === String(principal.userId)) continue
            const isOnline = await deps.presenceService?.isOnline?.(String(userId))
            if (isOnline) continue
            await deps.notificationsService.notifyNewMessage({
              toUserId: String(userId),
              conversationId,
              messageId: created.id,
              preview,
              senderName: principal.username ?? undefined,
              senderId: principal.userId,
            }).catch((e: any) => logger.warn('[messages] notifyNewMessage failed', e?.message))
          }
        }
      }

      _postSendSideEffects().catch((e: any) =>
        logger.error('[messages] post-send side effects failed', e?.stack ?? e?.message),
      )
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

      // Soft-delete the message for everyone: view-once content must not persist
      const deleted = await deps.messagesService.deleteMessage({
        senderId: principal.userId,
        conversationId,
        messageId,
      })

      // Broadcast the deletion so all recipients clear it immediately
      safeEmit(server, rooms.convRoom(conversationId), EVT.DELETE, deleted ?? { conversationId, messageId })

      safeAck(ack, ok({ viewed: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'View-once acknowledgement failed', 'ERROR'))
    }
  })

  socket.on(EVT.SCHEDULE_CANCEL, async (payload: { conversationId: string; messageId: string }, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { conversationId, messageId } = payload || {}

    if (!conversationId || !messageId) {
      return safeAck(ack, err('conversationId and messageId are required', 'BAD_REQUEST'))
    }

    try {
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      const deleted = await deps.messagesService.deleteMessage({
        senderId: principal.userId,
        conversationId,
        messageId,
      })
      safeAck(ack, ok({ cancelled: true, messageId: (deleted as any)?._id?.toString() ?? messageId }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Schedule cancel failed', 'ERROR'))
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
      await deps.rateLimitService.assert(principal, `history:${conversationId}`, 30)
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
