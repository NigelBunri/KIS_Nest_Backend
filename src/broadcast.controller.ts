import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { IsString } from 'class-validator'

import { FeatureFlag, FeatureFlagGuard } from './feature-flag.guard'
import { Scopes, ScopesGuard } from './scopes.guard'
import { BroadcastService } from './broadcast.service'
import { BroadcastReactionsService } from './broadcast-reactions.service'
import { BroadcastVertical } from './broadcast.types'
import { getRequestPrincipal, resolveTenantId } from './request.helpers'
import { HttpAuthGuard } from './auth/http-auth.guard'

class BroadcastReactionDto {
  @IsString()
  type!: string
}

@UseGuards(HttpAuthGuard, FeatureFlagGuard, ScopesGuard)
@FeatureFlag('FF_BROADCAST_CORE')
@Controller('api/v1/broadcast')
export class BroadcastController {
  constructor(
    private readonly broadcastService: BroadcastService,
    private readonly reactionsService: BroadcastReactionsService,
  ) {}

  @Get()
  async list(
    @Query('vertical') vertical: BroadcastVertical,
    @Query('limit') limit: string,
    @Query('cursor') cursor: string,
    @Req() req: FastifyRequest,
  ) {
    const tenantId = resolveTenantId(req)
    const parsedLimit = Number.isFinite(Number(limit)) ? Math.max(Math.floor(Number(limit)), 1) : undefined
    const response = await this.broadcastService.listForVertical({
      tenantId,
      vertical,
      cursor,
      limit: parsedLimit,
    })
    return {
      data: response.items,
      cursor: response.nextCursor,
    }
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: FastifyRequest) {
    const tenantId = resolveTenantId(req)
    const item = await this.broadcastService.findById(id, tenantId)
    if (!item) {
      throw new NotFoundException('broadcast not found')
    }
    return item
  }

  @Post(':id/reactions')
  @Scopes('broadcast:write')
  async react(@Param('id') id: string, @Body() body: BroadcastReactionDto, @Req() req: FastifyRequest) {
    const tenantId = resolveTenantId(req)
    const item = await this.broadcastService.findById(id, tenantId)
    if (!item) {
      throw new NotFoundException('broadcast not found')
    }
    const principal = getRequestPrincipal(req)
    if (!principal?.userId) {
      throw new UnauthorizedException('missing principal')
    }
    const reaction = await this.reactionsService.addReaction({
      broadcastItemId: id,
      type: body.type,
      userId: principal.userId,
    })
    return { ok: true, reaction }
  }
}
