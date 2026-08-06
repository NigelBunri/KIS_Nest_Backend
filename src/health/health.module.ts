import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [HealthController],
})
export class HealthModule {}
