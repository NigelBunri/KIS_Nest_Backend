import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UploadsController } from './uploads.controller';
import { MediaCleanupService } from './media-cleanup.service';
import { AuthModule } from '../auth/auth.module';
import { HttpAuthGuard } from '../auth/http-auth.guard';
import { StorageModule } from '../storage/storage.module';
import { Message, MessageSchema } from '../chat/features/messages/schemas/message.schema';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
  ],
  controllers: [UploadsController],
  providers: [HttpAuthGuard, MediaCleanupService],
})
export class UploadsModule {}
