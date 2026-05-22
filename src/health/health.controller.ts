import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { FastifyReply } from 'fastify';
import type { Connection } from 'mongoose';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  ok(@Res({ passthrough: true }) reply: FastifyReply) {
    const mongoReady = this.connection.readyState === 1;
    const checks = {
      mongodb: mongoReady ? 'ok' : 'unavailable',
      django_introspect_configured: Boolean(process.env.DJANGO_INTROSPECT_URL),
      django_internal_token_configured: Boolean(process.env.DJANGO_INTERNAL_TOKEN),
      origins_configured: Boolean(process.env.ORIGINS),
    };
    const healthy = mongoReady;

    if (!healthy) {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: healthy ? 'ok' : 'error',
      service: 'kis-nest-backend',
      uptime_seconds: Math.round(process.uptime()),
      checks,
      at: new Date().toISOString(),
    };
  }
}
