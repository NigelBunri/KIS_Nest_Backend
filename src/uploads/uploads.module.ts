import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { UploadsController } from './uploads.controller';
import { MediaCleanupService } from './media-cleanup.service';
import { UploadIntentService } from './upload-intent.service';
import { AttachmentAccessService } from './attachment-access.service';
import { UploadIntent, UploadIntentSchema } from './schemas/upload-intent.schema';
import { AuthModule } from '../auth/auth.module';
import { HttpAuthGuard } from '../auth/http-auth.guard';
import { StorageModule } from '../storage/storage.module';
import { Message, MessageSchema } from '../chat/features/messages/schemas/message.schema';
import { DjangoConversationClient } from '../chat/integrations/django/django-conversation.client';

@Module({
  imports: [
    AuthModule,
    HttpModule,
    StorageModule,
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: UploadIntent.name, schema: UploadIntentSchema },
    ]),
  ],
  controllers: [UploadsController],
  providers: [HttpAuthGuard, MediaCleanupService, UploadIntentService, AttachmentAccessService, DjangoConversationClient],
})
export class UploadsModule {}
