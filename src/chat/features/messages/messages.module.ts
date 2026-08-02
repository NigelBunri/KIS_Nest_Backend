// src/features/messages/messages.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessagesService } from './messages.service';
import { Message, MessageSchema } from './schemas/message.schema';
import { UploadIntent, UploadIntentSchema } from '../../../uploads/schemas/upload-intent.schema';


@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: UploadIntent.name, schema: UploadIntentSchema },
    ]),
  ],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
