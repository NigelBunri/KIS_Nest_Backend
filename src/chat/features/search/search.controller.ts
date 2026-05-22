import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DjangoAuthService } from '../../../auth/django-auth.service';
import { DjangoConversationClient } from '../../integrations/django/django-conversation.client';
import { SearchService } from './search.service';

@Controller('messages')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly authService: DjangoAuthService,
    private readonly djangoConversationClient: DjangoConversationClient,
  ) {}

  private async resolveUser(req: FastifyRequest) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = authHeader.slice('Bearer '.length);
    const principal = await this.authService.introspect(token);
    return { principal, token };
  }

  @Get('search')
  async search(
    @Req() req: FastifyRequest,
    @Query('conversationId') conversationId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('threadId') threadId?: string,
  ) {
    const cleanConversationId = String(conversationId || '').trim();
    const cleanQuery = String(q || '').trim();
    if (!cleanConversationId || !cleanQuery) {
      return { ok: true, data: { messages: [] }, messages: [] };
    }

    const { principal, token } = await this.resolveUser(req);
    await this.djangoConversationClient.assertMember(
      { userId: principal.userId, token },
      cleanConversationId,
    );

    const parsedLimit = limit ? Number(limit) : undefined;
    const parsedSkip = skip ? Number(skip) : undefined;
    const result = await this.searchService.searchConversationMessages({
      conversationId: cleanConversationId,
      q: cleanQuery,
      limit: Number.isFinite(parsedLimit as number) ? parsedLimit : undefined,
      skip: Number.isFinite(parsedSkip as number) ? parsedSkip : undefined,
      threadId: threadId ? String(threadId) : undefined,
    });

    return {
      ok: true,
      data: { messages: result.results, results: result.results },
      messages: result.results,
      results: result.results,
    };
  }
}
