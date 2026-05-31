import { Controller, Get } from '@nestjs/common';

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
}
