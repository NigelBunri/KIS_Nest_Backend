import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

@Module({
  controllers: [MetricsController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    MetricsService,
  ],
  exports: [MetricsService],
})
export class ObservabilityModule {}
