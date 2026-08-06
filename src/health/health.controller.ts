import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { FastifyReply } from 'fastify';
import type { Connection } from 'mongoose';
import { NotificationsService } from '../notifications/notifications.service';

@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  ok(@Res({ passthrough: true }) reply: FastifyReply) {
    const mongoReady = this.connection.readyState === 1;
    const push = this.notifications.getProviderStatus();
    const checks = {
      mongodb: mongoReady ? 'ok' : 'unavailable',
      django_introspect_configured: Boolean(process.env.DJANGO_INTROSPECT_URL),
      django_internal_token_configured: Boolean(process.env.DJANGO_INTERNAL_TOKEN),
      origins_configured: Boolean(process.env.ORIGINS),
      // Never expose credential values — only whether each provider
      // actually initialized. A production deployment with fcm_configured:
      // false is running on DummyPushProvider and silently dropping every
      // chat/call push — this is the signal to watch for that.
      push_fcm_configured: push.fcm_configured,
      push_apns_voip_configured: push.apns_voip_configured,
      push_active_provider: push.active_push_provider,
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
