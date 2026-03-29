import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsService } from './notifications.service';
import { DeviceTokensService } from './device-tokens.service';
import { DeviceToken, DeviceTokenSchema } from './schemas/device-token.schema';
import { NotificationsController } from './notifications.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DeviceToken.name, schema: DeviceTokenSchema }]),
    AuthModule,
  ],
  providers: [NotificationsService, DeviceTokensService],
  controllers: [NotificationsController],
  exports: [NotificationsService, DeviceTokensService],
})
export class NotificationsModule {}
