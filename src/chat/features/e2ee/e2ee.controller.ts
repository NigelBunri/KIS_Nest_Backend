import {
  Controller,
  Get,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common'

import { DjangoConversationClient } from '../../integrations/django/django-conversation.client'
import { HttpAuthGuard } from '../../../auth/http-auth.guard'
import { SocketPrincipal } from '../../chat.types'
import { E2eeKeysService } from './e2ee-keys.service'

@Controller('api/v1/e2ee/conversations')
@UseGuards(HttpAuthGuard)
export class E2eeController {
  constructor(
    private readonly e2eeKeysService: E2eeKeysService,
    private readonly djangoConversationClient: DjangoConversationClient,
  ) {}

  @Get(':conversationId/key')
  async getKey(@Param('conversationId') conversationId: string, @Req() req: any) {
    const principal = req?.principal as SocketPrincipal | undefined
    if (!principal?.userId) {
      throw new Error('Missing principal')
    }

    await this.djangoConversationClient.assertMember(principal, conversationId)
    const entry = await this.e2eeKeysService.ensureKey(conversationId)
    return {
      key: entry.key,
      version: entry.version,
      encryptionVersion: 'custom-aes-2',
    }
  }
}
