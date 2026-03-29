import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ModerationService } from './moderation.service';
import {
  MessageReport,
  MessageReportSchema,
  ConversationBlock,
  ConversationBlockSchema,
  ConversationMute,
  ConversationMuteSchema,
} from './moderation.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MessageReport.name, schema: MessageReportSchema },
      { name: ConversationBlock.name, schema: ConversationBlockSchema },
      { name: ConversationMute.name, schema: ConversationMuteSchema },
    ]),
  ],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
