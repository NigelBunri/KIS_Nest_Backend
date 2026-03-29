import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { IsArray, IsOptional, IsString } from 'class-validator'

import { FeatureFlag, FeatureFlagGuard } from './feature-flag.guard'
import { Scopes, ScopesGuard } from './scopes.guard'
import { BroadcastService } from './broadcast.service'
import { BroadcastSourceType, BroadcastVertical } from './broadcast.types'
import { FeedsService } from './feeds.service'
import { MessagesService } from './chat/features/messages/messages.service'
import { HttpAuthGuard } from './auth/http-auth.guard'
import { extractIdempotencyKey, getRequestPrincipal, resolveTenantId } from './request.helpers'

class CreateFeedPostDto {
  @IsOptional()
  @IsString()
  text?: string

  @IsOptional()
  @IsArray()
  attachments?: any[]

  @IsOptional()
  @IsString()
  communityId?: string

  @IsOptional()
  @IsString()
  partnerProfileId?: string
}

class BroadcastChannelMessageDto {
  @IsString()
  channelMessageId!: string

  @IsOptional()
  @IsString()
  conversationId?: string

  @IsOptional()
  @IsString()
  communityId?: string

  @IsOptional()
  @IsString()
  partnerProfileId?: string
}

@UseGuards(HttpAuthGuard, FeatureFlagGuard, ScopesGuard)
@FeatureFlag('FF_FEEDS_BROADCAST')
@Controller('api/v1/feeds')
export class FeedsController {
  constructor(
    private readonly feedsService: FeedsService,
    private readonly broadcastService: BroadcastService,
    private readonly messagesService: MessagesService,
  ) {}

  @Post()
  @Scopes('broadcast:write')
  async create(@Body() body: CreateFeedPostDto, @Req() req: FastifyRequest) {
    const tenantId = resolveTenantId(req)
    const principal = getRequestPrincipal(req)
    if (!principal?.userId) {
      throw new UnauthorizedException('missing principal')
    }
    const post = await this.feedsService.create({
      tenantId,
      authorId: principal.userId,
      text: body.text,
      attachments: body.attachments,
      communityId: body.communityId,
      partnerProfileId: body.partnerProfileId,
    })
    return post
  }

  @Post(':id/broadcast')
  @Scopes('broadcast:write')
  async broadcast(@Param('id') id: string, @Req() req: FastifyRequest) {
    const tenantId = resolveTenantId(req)
    const principal = getRequestPrincipal(req)
    if (!principal?.userId) {
      throw new UnauthorizedException('missing principal')
    }
    const feedPost = await this.feedsService.findById(tenantId, id)
    if (!feedPost) {
      throw new NotFoundException('feed not found')
    }
    const broadcast = await this.broadcastService.createItem({
      tenantId,
      creatorId: principal.userId,
      sourceType: BroadcastSourceType.FEED_POST,
      vertical: BroadcastVertical.FEEDS,
      sourceId: feedPost._id.toString(),
      title: feedPost.text ? feedPost.text.slice(0, 120) : 'Feed update',
      body: feedPost.text,
      attachments: feedPost.attachments,
      metadata: { feedPostId: feedPost._id.toString() },
      idempotencyKey: extractIdempotencyKey(req),
    })
    return broadcast
  }

  @Post('broadcast-from-channel')
  @Scopes('broadcast:write')
  async broadcastFromChannel(@Body() body: BroadcastChannelMessageDto, @Req() req: FastifyRequest) {
    const tenantId = resolveTenantId(req)
    const principal = getRequestPrincipal(req)
    if (!principal?.userId) {
      throw new UnauthorizedException('missing principal')
    }
    const messages = await this.messagesService.listByIds({
      messageIds: [body.channelMessageId],
      conversationId: body.conversationId,
    })
    const message = messages[0]
    if (!message) {
      throw new NotFoundException('message not found')
    }
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    const text = typeof message.text === 'string' ? message.text : message.previewText ?? ''
    const feedPost = await this.feedsService.create({
      tenantId,
      authorId: principal.userId,
      text,
      attachments,
      communityId: body.communityId,
      partnerProfileId: body.partnerProfileId,
      channelMessageId: body.channelMessageId,
      sourceConversationId: body.conversationId,
    })
    const broadcast = await this.broadcastService.createItem({
      tenantId,
      creatorId: principal.userId,
      sourceType: BroadcastSourceType.FEED_POST,
      vertical: BroadcastVertical.FEEDS,
      sourceId: feedPost._id.toString(),
      title: text ? text.slice(0, 120) : 'Channel update',
      body: text,
      attachments,
      metadata: {
        feedPostId: feedPost._id.toString(),
        channelMessageId: body.channelMessageId,
        conversationId: body.conversationId,
      },
      idempotencyKey: extractIdempotencyKey(req),
    })
    return { feedPost, broadcast }
  }
}
