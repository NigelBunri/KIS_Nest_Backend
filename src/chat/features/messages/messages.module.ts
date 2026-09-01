// src/features/messages/messages.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { VoicePlaybackService } from './voice-playback.service';
import { MessageRetentionCron } from './message-retention.cron';
import { Message, MessageSchema } from './schemas/message.schema';
import { UploadIntent, UploadIntentSchema } from '../../../uploads/schemas/upload-intent.schema';
import { AuthModule } from '../../../auth/auth.module';
import { HttpAuthGuard } from '../../../auth/http-auth.guard';
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client';
import { DjangoMediaClient } from '../../integrations/django/django-media.client';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { ObservabilityModule } from '../../../observability/observability.module';
import { StorageModule } from '../../../storage/storage.module';


@Module({
  imports: [
    AuthModule,
    HttpModule,
    ObservabilityModule,
    StorageModule,
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: UploadIntent.name, schema: UploadIntentSchema },
    ]),
  ],
  controllers: [MessagesController],
  providers: [
    MessagesService,
    VoicePlaybackService,
    HttpAuthGuard,
    DjangoConversationClient,
    DjangoMediaClient,
    RateLimitService,
    MessageRetentionCron,
  ],
  // DjangoConversationClient is exported alongside MessagesService so that
  // any module pulling messages out of a conversation (e.g. FeedsModule's
  // broadcast-from-channel) can enforce membership on the conversationId it
  // is given, instead of trusting it unchecked.
  exports: [MessagesService, DjangoConversationClient],
})
export class MessagesModule {}
