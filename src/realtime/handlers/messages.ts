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

function assertSafeMessageMedia(payload: SendMessagePayload) {
  const attachments = Array.isArray((payload as any)?.attachments)
    ? (payload as any).attachments
    : []
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

    try {
      const hasEncryptedPayload = !!(
        payload?.ciphertext ||
        payload?.encryptionMeta ||
        payload?.encrypted
      )

      await deps.rateLimitService.assert(principal, `send:${conversationId}`, 50)
      const perms = await deps.djangoConversationClient.assertMember(principal, conversationId)
      assertSafeMessageMedia(payload)

      logger.log('[messages] perms result', perms)

      const canSend =
        perms?.canSend === true ||
        (
          perms?.isMember === true &&
          perms?.isBlocked !== true &&
          perms?.role === 'member'
        )
      if (!canSend) {
        throw new Error('Send not allowed in this conversation')
      }
      if (deps.djangoConversationClient.policyCheck) {
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

      const seq = deps.djangoSeqClient.allocateSeq
        ? await deps.djangoSeqClient.allocateSeq(conversationId)
        : deps.djangoSeqClient.allocate
        ? await deps.djangoSeqClient.allocate(conversationId)
        : (() => {
            throw new Error('Seq allocator not configured')
          })()

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

        const listMembers = deps.djangoConversationClient.listMemberIds
        if (listMembers) {
          const memberIds = await listMembers(conversationId).catch((e: any) => {
            logger.warn('[messages] listMemberIds failed', e?.message)
            return [] as string[]
          })
          for (const userId of memberIds) {
            safeEmit(server, rooms.userRoom(String(userId)), EVT.CONVERSATION_UPDATED, {
              event: EVT.CONVERSATION_UPDATED,
              reason: 'message_created',
              conversationId,
              messageId: created.id,
              senderId: principal.userId,
              preview,
              lastMessageAt: created.createdAt.toISOString(),
              seq: created.seq,
            })
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
      logger.error(
        `[messages] send failed conversationId=${conversationId} userId=${principal?.userId}`,
        e?.stack ?? e?.message ?? e,
      )
      safeAck(ack, err(e?.message ?? 'Send failed', 'ERROR'))
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

    try {
      await deps.rateLimitService.assert(principal, `edit:${conversationId}`, 60)
      const perms = await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (perms?.canSend === false) {
        throw new Error('Edit not allowed in this conversation')
      }
      if (deps.moderationService) {
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
      safeAck(ack, err(e?.message ?? 'Edit failed', 'ERROR'))
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

    try {
      await deps.rateLimitService.assert(principal, `delete:${conversationId}`, 60)
      const perms = await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (perms?.canSend === false) {
        throw new Error('Delete not allowed in this conversation')
      }
      if (deps.moderationService) {
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'delete',
        })
      }
      if (deps.djangoConversationClient.policyCheck) {
        const policy = await deps.djangoConversationClient.policyCheck({
          principal,
          conversationId,
          action: 'delete',
        })
        if (policy?.allowed === false) {
          throw new Error(policy.reason || 'Policy blocked this delete')
        }
      }

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
      safeAck(ack, err(e?.message ?? 'Delete failed', 'ERROR'))
    }
  })

  socket.on(EVT.HISTORY, async (payload: HistoryPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)

    const validation = await validateSocketPayload(HistoryDto, payload)
    if (!validation.ok) {
      return safeAck(ack, err(validation.errors.join('; '), 'BAD_REQUEST'))
    }

    const conversationId = payload?.conversationId

    try {
      await deps.rateLimitService.assert(principal, `history:${conversationId}`, 30)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      const items = await deps.messagesService.listRecent({
        conversationId,
        limit: payload?.limit,
        before: payload?.before,
        after: payload?.after,
      })

      safeAck(ack, ok({ messages: items }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'History failed', 'ERROR'))
    }
  })
}
