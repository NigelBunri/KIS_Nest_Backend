import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { MetricsService } from './metrics.service';

@Controller('metrics')
@UseGuards(InternalAuthGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  get() {
    return this.metrics.renderPrometheusText();
  }
}
