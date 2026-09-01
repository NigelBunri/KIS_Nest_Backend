import { BadRequestException, Body, Controller, Param, Post, UseGuards } from '@nestjs/common'

import { InternalAuthGuard } from '../auth/internal-auth.guard'
import { AttachmentAccessService } from '../uploads/attachment-access.service'
import { MessagesService } from '../chat/features/messages/messages.service'
import { rooms } from '../chat/chat.types'
import { ChatGateway } from './chat.gateway'

type ConversationCreatedPayload = {
  conversationId: string
  userIds: string[]
}

type MainTabBadgesUpdatedPayload = {
  event?: string
  userIds: string[]
  source?: string
  reason?: string
  extra?: Record<string, unknown>
}

type PartnerEventPayload = {
  event?: string
  userIds?: string[]
  data?: Record<string, unknown>
}

@Controller('internal')
@UseGuards(InternalAuthGuard)
export class RealtimeInternalController {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly attachmentAccess: AttachmentAccessService,
    private readonly messagesService: MessagesService,
  ) {}

  @Post('conversations/created')
  handleConversationCreated(@Body() payload: ConversationCreatedPayload) {
    const conversationId = String(payload?.conversationId ?? '')
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : []
    if (!conversationId || userIds.length === 0) {
      return { ok: false }
    }

    for (const userId of userIds) {
      if (!userId) continue
      try {
        this.gateway.server
          ?.to(rooms.userRoom(String(userId)))
          .emit('conversation.created', {
            conversationId,
            userId: String(userId),
          })
      } catch {}
    }

    return { ok: true }
  }

  @Post('main-tab-badges/updated')
  handleMainTabBadgesUpdated(@Body() payload: MainTabBadgesUpdatedPayload) {
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : []
    const cleanUserIds = Array.from(
      new Set(userIds.map((value) => String(value || '').trim()).filter(Boolean)),
    )
    if (cleanUserIds.length === 0) {
      return { ok: false }
    }

    const event = 'main_tab_badges.updated'
    const body = {
      event,
      source: String(payload?.source || 'unknown'),
      reason: String(payload?.reason || ''),
      extra: payload?.extra || {},
      at: new Date().toISOString(),
    }

    for (const userId of cleanUserIds) {
      try {
        this.gateway.server?.to(rooms.userRoom(userId)).emit(event, {
          ...body,
          userId,
        })
      } catch {}
    }

    return { ok: true, emitted: cleanUserIds.length }
  }

  // Django calls this after a Partners-system change that affected users
  // should see live (kick/ban, role update, invite redeemed, channel or
  // category created) — see apps.partners.services.notify_nest_of_partner_event
  // on the Django side. Generic fan-out, same shape as main-tab-badges/updated
  // above: no partner-scoped socket room exists (or is needed) since every
  // affected user already has a userRoom from being connected at all.
  @Post('partners/:partnerId/events')
  handlePartnerEvent(@Param('partnerId') partnerId: string, @Body() payload: PartnerEventPayload) {
    const event = String(payload?.event || '').trim()
    const userIds = Array.from(
      new Set((Array.isArray(payload?.userIds) ? payload.userIds : []).map((v) => String(v || '').trim()).filter(Boolean)),
    )
    if (!event || userIds.length === 0) {
      return { ok: false }
    }

    const body = {
      event,
      partnerId: String(partnerId || ''),
      data: payload?.data || {},
      at: new Date().toISOString(),
    }

    for (const userId of userIds) {
      try {
        this.gateway.server?.to(rooms.userRoom(userId)).emit(event, { ...body, userId })
      } catch {}
    }

    return { ok: true, emitted: userIds.length }
  }

  // Django's async explicit-content scan calls this after confirming a
  // violation on a direct-to-S3 upload (see apps/media/tasks.py's
  // scan_uploaded_object_task on the Django side) — takes the content down
  // immediately by flipping the matching attachment's quarantined flag.
  @Post('attachments/quarantine')
  quarantineAttachment(@Body() body: { objectKey?: string }) {
    const objectKey = String(body?.objectKey || '').trim()
    if (!objectKey) {
      throw new BadRequestException('objectKey is required.')
    }
    return this.attachmentAccess.quarantineByStorageKey(objectKey).then((found) => ({ ok: true, found }))
  }

  // Django's account-purge sweep calls this once a deleted account's grace
  // period has elapsed (apps.accounts.tasks.purge_accounts_past_grace_period
  // on the Django side) - Django hard-deleting the user row does nothing to
  // this user's chat messages, which live entirely in Mongo, so without this
  // call "delete account" would only ever remove the Django row while every
  // message they sent stayed fully readable to other members forever.
  @Post('users/:userId/purge-messages')
  async purgeUserMessages(@Param('userId') userId: string) {
    const cleanUserId = String(userId || '').trim()
    if (!cleanUserId) {
      throw new BadRequestException('userId is required.')
    }

    const { scrubbed, conversationIds } = await this.messagesService.purgeMessagesForUser(cleanUserId)

    for (const conversationId of conversationIds) {
      try {
        this.gateway.server?.to(rooms.convRoom(conversationId)).emit('messages.purged', {
          conversationId,
          senderId: cleanUserId,
          reason: 'account_deletion',
        })
      } catch {}
    }

    return { ok: true, scrubbed, conversations: conversationIds.length }
  }

  // Django's StaffModerationOperationActionView calls this when a staff
  // moderator actions ("block") a chat_message_report - the follow-through
  // on making chat message reports actually decidable, not just visible in
  // the staff queue (see apps.moderation.views._staff_queue_chat_message_
  // report_rows and ChatMessageReportView on the Django side). Unlike a
  // user's own delete-for-everyone (deleteMessageLegacy), this doesn't
  // require the caller to be the message's sender - authorization here is
  // Django's IsAdminUser check on the report action, not sender identity.
  @Post('conversations/:conversationId/messages/:messageId/moderate-delete')
  async moderatorDeleteMessage(
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    const cleanConversationId = String(conversationId || '').trim()
    const cleanMessageId = String(messageId || '').trim()
    if (!cleanConversationId || !cleanMessageId) {
      throw new BadRequestException('conversationId and messageId are required.')
    }

    const { found } = await this.messagesService.moderatorDeleteMessage({
      conversationId: cleanConversationId,
      messageId: cleanMessageId,
    })

    if (found) {
      try {
        this.gateway.server?.to(rooms.convRoom(cleanConversationId)).emit('message.moderated_delete', {
          conversationId: cleanConversationId,
          messageId: cleanMessageId,
        })
      } catch {}
    }

    return { ok: true, found }
  }
}
