import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { CallsService } from './calls.service'
import { DjangoAuthService } from '../../../auth/django-auth.service'

@Controller('calls')
export class CallsController {
  constructor(
    private readonly callsService: CallsService,
    private readonly authService: DjangoAuthService,
  ) {}

  private async resolveUser(req: FastifyRequest) {
    const authHeader = req.headers.authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token')
    }
    const token = authHeader.slice('Bearer '.length)
    const principal = await this.authService.introspect(token)
    return principal
  }

  @Get('history')
  async history(
    @Req() req: FastifyRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const principal = await this.resolveUser(req)
    const parsedLimit = limit ? Number(limit) : undefined
    return this.callsService.listUserCalls({
      userId: principal.userId,
      limit: Number.isFinite(parsedLimit as number) ? parsedLimit : undefined,
      before,
    })
  }
}
