import { Controller, Logger, Param, Post, UseGuards } from '@nestjs/common'
import { HttpAuthGuard } from '../../../auth/http-auth.guard'
import { BroadcastConversationsService } from './broadcast-conversation.service'

@Controller('api/v1/broadcasts')
@UseGuards(HttpAuthGuard)
export class BroadcastCommentsController {
  private readonly logger = new Logger(BroadcastCommentsController.name)

  constructor(
    private readonly conversations: BroadcastConversationsService,
  ) {}

  @Post(':id/comment-room')
  async commentRoom(@Param('id') broadcastId: string) {
    const conversation = await this.conversations.ensureConversation(broadcastId)
    this.logger.log(`[comment-room] broadcast=${broadcastId} -> conversation=${conversation.conversationId}`)

    return {
      conversation_id: conversation.conversationId,
      title: conversation.title,
    }
  }
}
