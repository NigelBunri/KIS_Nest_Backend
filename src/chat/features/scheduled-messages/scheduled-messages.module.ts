// src/chat/features/scheduled-messages/scheduled-messages.module.ts

import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { ScheduleModule } from '@nestjs/schedule'

import { ScheduledMessage, ScheduledMessageSchema } from './schemas/scheduled-message.schema'
import { ScheduledMessagesService } from './scheduled-messages.service'
import { ScheduledMessagesCron } from './scheduled-messages.cron'
import { DjangoSeqClient } from '../../integrations/django/django-seq.client'
import { AuthModule } from '../../../auth/auth.module'
import { MessagesModule } from '../messages/messages.module'
import { NotificationsModule } from '../../../notifications/notifications.module'
import { ModerationModule } from '../moderation/moderation.module'

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ScheduledMessage.name, schema: ScheduledMessageSchema }]),
    ScheduleModule.forRoot(),
    AuthModule,
    // MessagesModule exports both MessagesService (createIdempotent — the
    // real send pipeline) and DjangoConversationClient (membership/policy
    // checks), so both the cron and the controller get them from here
    // instead of each constructing/duplicating their own.
    MessagesModule,
    NotificationsModule,
    ModerationModule,
  ],
  providers: [
    ScheduledMessagesService,
    ScheduledMessagesCron,
    DjangoSeqClient,
  ],
  exports: [ScheduledMessagesService, ScheduledMessagesCron],
})
export class ScheduledMessagesModule {}
