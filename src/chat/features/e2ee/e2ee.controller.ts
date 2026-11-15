import {
  Controller,
  Get,
  NotFoundException,
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
    // Only ever serves a key that already exists (legacy decrypt of
    // pre-migration message history) - see E2eeKeysService's own doc
    // comment (Defect D2) for why this must never mint a new one.
    const entry = await this.e2eeKeysService.getExistingKey(conversationId)
    if (!entry) {
      throw new NotFoundException('No legacy encryption key for this conversation.')
    }
    return {
      key: entry.key,
      version: entry.version,
      encryptionVersion: 'custom-aes-2',
    }
  }
}
