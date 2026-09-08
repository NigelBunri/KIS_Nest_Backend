import { randomUUID } from 'crypto'

import { BadRequestException, Body, Controller, Param, Post, UseGuards } from '@nestjs/common'

import { InternalAuthGuard } from '../auth/internal-auth.guard'
import { AttachmentAccessService } from '../uploads/attachment-access.service'
import { MessagesService } from '../chat/features/messages/messages.service'
import { DjangoSeqClient } from '../chat/integrations/django/django-seq.client'
import { DjangoConversationClient } from '../chat/integrations/django/django-conversation.client'
import { EVT, MessageKind, rooms } from '../chat/chat.types'
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

type CommunityEventPayload = {
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
    private readonly seqClient: DjangoSeqClient,
    private readonly conversationClient: DjangoConversationClient,
  ) {}

  // Django's Status-reply endpoint calls this (apps/statuses/views.py::reply)
  // to actually deliver a reply-to-a-status as a real message in the DM
  // conversation between the viewer and the status's author. Django itself
  // has no Message model at all — every conversation's real content lives
  // here in Mongo (see message.schema.ts) — so "create a message on this
  // user's behalf" has to be a real internal call into the same pipeline a
  // live socket send uses (seq allocation + createIdempotent), not a
  // second, parallel persistence path.
  //
  // Deliberately narrower than a full socket send: it emits chat.message to
  // the conversation room (so an already-open chat updates live) and
  // updates Django's last-message preview, but does NOT run the live-send
  // handler's broader fan-out (per-member CONVERSATION_UPDATED/badge
  // events, offline push notification). A status reply is a background,
  // occasional action, not a primary chat surface — see the Phase 4 report
  // for this explicitly flagged as a smaller, deferred follow-up rather
  // than silently claimed as full parity with a live chat send.
  @Post('messages/send-as-user')
  async sendMessageAsUser(
    @Body() body: { conversationId?: string; senderId?: string; text?: string; clientId?: string },
  ) {
    const conversationId = String(body?.conversationId || '').trim()
    const senderId = String(body?.senderId || '').trim()
    const text = String(body?.text || '').trim()
    if (!conversationId || !senderId || !text) {
      throw new BadRequestException('conversationId, senderId, and text are required.')
    }

    const clientId = String(body?.clientId || '').trim() || randomUUID()
    const seq = await this.seqClient.allocateSeq(conversationId)
    const created = await this.messagesService.createIdempotent({
      senderId,
      conversationId,
      clientId,
      seq,
      input: { conversationId, clientId, kind: MessageKind.TEXT, text },
    })

    const createdDto = (created as any).dto ?? created
    try {
      this.gateway.server?.to(rooms.convRoom(conversationId)).emit(EVT.MESSAGE, createdDto)
    } catch {}

    await this.conversationClient
      .updateLastMessage({ conversationId, createdAt: created.createdAt, preview: text })
      .catch(() => {})

    return {
      ok: true,
      messageId: created.id,
      seq: created.seq,
      conversationId,
      clientId,
      createdAt: created.createdAt,
    }
  }

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

  // Django calls this after a Community-system change that affected users
  // should see live (member joined/left/removed/banned, role changed,
  // join request created/decided, post created/updated/deleted, new
  // comment) — see apps.communities.realtime.notify_nest_of_community_event
  // on the Django side. Same generic per-user-room fan-out shape as
  // partners/:partnerId/events above - copied rather than shared because
  // the two systems' event catalogs are independent and unlikely to need
  // to change in lockstep; a shared generic entities/:type/:id/events
  // endpoint would be a reasonable follow-up if a third caller ever needs
  // this same shape.
  @Post('communities/:communityId/events')
  handleCommunityEvent(@Param('communityId') communityId: string, @Body() payload: CommunityEventPayload) {
    const event = String(payload?.event || '').trim()
    const userIds = Array.from(
      new Set((Array.isArray(payload?.userIds) ? payload.userIds : []).map((v) => String(v || '').trim()).filter(Boolean)),
    )
    if (!event || userIds.length === 0) {
      return { ok: false }
    }

    const body = {
      event,
      communityId: String(communityId || ''),
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
