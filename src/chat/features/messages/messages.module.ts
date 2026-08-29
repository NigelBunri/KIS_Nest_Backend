// src/features/messages/messages.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { VoicePlaybackService } from './voice-playback.service';
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
  ],
  exports: [MessagesService],
})
export class MessagesModule {}
