import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { AuthModule } from '../../../auth/auth.module';
import { HttpModule } from '@nestjs/axios';
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client';
import { Message, MessageSchema } from '../messages/schemas/message.schema';

@Module({
  imports: [
    AuthModule,
    HttpModule,
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
  ],
  controllers: [SearchController],
  providers: [SearchService, DjangoConversationClient],
  exports: [SearchService],
})
export class SearchModule {}
