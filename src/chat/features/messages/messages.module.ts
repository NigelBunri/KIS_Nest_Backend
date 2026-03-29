// src/features/messages/messages.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessagesService } from './messages.service';
import { Message, MessageSchema } from './schemas/message.schema';


@Module({
  imports: [MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }])],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
