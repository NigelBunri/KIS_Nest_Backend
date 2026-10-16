// src/chat/features/scheduled-messages/scheduled-messages.cron.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Server } from 'socket.io'
import { ScheduledMessagesService } from './scheduled-messages.service'
import { ScheduledMessageDocument } from './schemas/scheduled-message.schema'
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client'
import { DjangoSeqClient } from '../../integrations/django/django-seq.client'
import { MessagesService } from '../messages/messages.service'
import { ModerationService } from '../moderation/moderation.service'
import { NotificationsService } from '../../../notifications/notifications.service'
import { broadcastCreatedMessage, runPostSendSideEffects } from '../../../realtime/handlers/messages'
import { EVT, rooms } from '../../chat.types'

// How many due items one poll tick will attempt to claim+deliver. Kept
// modest since each is delivered serially (membership re-check + seq
// allocation + persistence + broadcast + push fan-out) — a backlog just
// gets picked up over the next few ticks rather than risking a slow herd
// blocking the event loop.
const BATCH_SIZE = 10

@Injectable()
export class ScheduledMessagesCron implements OnModuleInit {
  private readonly logger = new Logger(ScheduledMessagesCron.name)
  private server?: Server

  constructor(
    private readonly scheduledMessagesService: ScheduledMessagesService,
    private readonly djangoConversationClient: DjangoConversationClient,
    private readonly djangoSeqClient: DjangoSeqClient,
    private readonly messagesService: MessagesService,
    private readonly moderationService: ModerationService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /** Called once by ChatGateway.afterInit() so the cron has a server reference to broadcast on. */
  setServer(server: Server) {
    this.server = server
  }

  async onModuleInit() {
    try {
      const recovered = await this.scheduledMessagesService.recoverStaleProcessing()
      if (recovered) {
        this.logger.warn(`[scheduled] recovered ${recovered} message(s) stuck in 'processing' on boot`)
      }
    } catch (e: any) {
      this.logger.error('[scheduled] boot recovery failed', e?.stack ?? e?.message)
    }
  }

  @Cron('*/15 * * * * *')
  async deliverDueMessages() {
    if (!this.server) return
    try {
      // Also run every tick, not just at boot — catches a crash mid-session
      // (this instance or another one) without waiting for a restart.
      await this.scheduledMessagesService.recoverStaleProcessing()

      const due = await this.scheduledMessagesService.claimNextDue(BATCH_SIZE)
      for (const item of due) {
        await this.deliverOne(item)
      }
    } catch (e: any) {
      this.logger.error('[scheduled] poll tick failed', e?.stack ?? e?.message)
    }
  }

  private async deliverOne(item: ScheduledMessageDocument): Promise<void> {
    const id = String((item as any)._id)
    try {
      // Re-check authorization at delivery time, not just at schedule time —
      // membership, blocks, and moderation state can all have changed in
      // the hours/days since this was scheduled (section 5's explicit
      // "verify recipients and group membership are authorized before
      // delivery" requirement).
      const perms = await this.djangoConversationClient.assertMember(
        { userId: item.senderId, deviceId: item.senderDeviceId } as any,
        item.conversationId,
      )
      const canSend = perms?.isMember === true && perms?.isBlocked !== true && perms?.canSend !== false
      if (!canSend) throw new Error('Sender is no longer allowed to send in this conversation')

      await this.moderationService.assertAllowed({
        conversationId: item.conversationId,
        userId: item.senderId,
        action: 'send',
      })

      const hasEncryptedPayload = !!(item.payload?.ciphertext || item.payload?.encryptionMeta || item.payload?.encrypted)
      if (this.djangoConversationClient.policyCheck) {
        const policy = await this.djangoConversationClient.policyCheck({
          principal: { userId: item.senderId } as any,
          conversationId: item.conversationId,
          action: 'send',
          text: hasEncryptedPayload ? undefined : (item.payload?.text ?? ''),
        })
        if (policy?.allowed === false) throw new Error(policy.reason || 'Policy blocked this message')
      }

      const seq = await this.djangoSeqClient.allocateSeq(item.conversationId)
      const created = await this.messagesService.createIdempotent({
        senderId: item.senderId,
        senderDeviceId: item.senderDeviceId,
        conversationId: item.conversationId,
        clientId: item.clientId,
        seq,
        input: item.payload as any,
      })

      const createdDto = created.dto ?? created
      broadcastCreatedMessage(this.server!, item.conversationId, createdDto)

      if (!created.reused) {
        const preview =
          createdDto?.previewText ?? (hasEncryptedPayload ? 'Encrypted message' : (createdDto?.text ?? item.payload?.text))
        await runPostSendSideEffects(
          { djangoConversationClient: this.djangoConversationClient, notificationsService: this.notificationsService },
          this.server!,
          {
            conversationId: item.conversationId,
            senderId: item.senderId,
            senderName: item.senderName,
            createdId: created.id,
            seq: created.seq,
            createdAt: created.createdAt,
            preview,
          },
        )
      }

      await this.scheduledMessagesService.markSent(id, { sentMessageId: created.id, sentSeq: created.seq })
      this.logger.log(`[scheduled] delivered scheduledMessageId=${id} messageId=${created.id} conversationId=${item.conversationId}`)
      this.notifyOwnerOfStatus(item, 'sent')
    } catch (e: any) {
      const permanent = item.attempts >= item.maxAttempts
      await this.scheduledMessagesService.markFailed(id, {
        error: String(e?.message ?? e ?? 'unknown error').slice(0, 500),
        permanent,
      })
      this.logger.warn(
        `[scheduled] delivery ${permanent ? 'permanently failed' : 'will retry'} scheduledMessageId=${id}: ${e?.message}`,
      )
      if (permanent) this.notifyOwnerOfStatus(item, 'failed')
    }
  }

  /**
   * Lets an open Scheduled Messages screen (on this or another of the
   * sender's devices) update live instead of polling. Also called directly
   * by ScheduledMessagesController after a cancel/reschedule REST call.
   */
  notifyOwnerOfStatus(item: ScheduledMessageDocument, status: 'sent' | 'failed' | 'cancelled' | 'scheduled') {
    if (!this.server) return
    try {
      this.server.to(rooms.userRoom(String(item.senderId))).emit(EVT.SCHEDULED_MESSAGE_UPDATED, {
        id: String((item as any)._id),
        conversationId: item.conversationId,
        status,
      })
    } catch (e: any) {
      this.logger.warn('[scheduled] owner notify failed', e?.message)
    }
  }
}
