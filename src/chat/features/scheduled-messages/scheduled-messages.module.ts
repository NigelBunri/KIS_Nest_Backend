// src/chat/features/scheduled-messages/scheduled-messages.module.ts

import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Message, MessageSchema } from '../messages/schemas/message.schema'
import { ScheduledMessagesService } from './scheduled-messages.service'

import { ScheduleModule } from '@nestjs/schedule'
import { ScheduledMessagesCron } from './scheduled-messages.cron'

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
    ScheduleModule.forRoot(),
  ],
  providers: [
    ScheduledMessagesService,
    ScheduledMessagesCron,
  ],
  exports: [ScheduledMessagesService, ScheduledMessagesCron],
})
export class ScheduledMessagesModule {}
