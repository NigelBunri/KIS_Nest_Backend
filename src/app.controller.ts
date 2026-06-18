import { Controller, Get, UseGuards } from '@nestjs/common';
import { HttpAuthGuard } from './auth/http-auth.guard';

@Controller()
export class AppController {
  @Get()
  root() {
    return {
      status: 'ok',
      service: 'kis-nest-backend',
      uptime_seconds: Math.round(process.uptime()),
      at: new Date().toISOString(),
    };
  }

  // Call history is stored locally on each device via AsyncStorage (logCall()).
  // This endpoint returns an empty list so the frontend falls back to local cache
  // without a 404 error. A full server-side history log can be added here later.
  @Get('api/v1/calls/history')
  @UseGuards(HttpAuthGuard)
  callsHistory() {
    return { results: [], count: 0 };
  }
}
