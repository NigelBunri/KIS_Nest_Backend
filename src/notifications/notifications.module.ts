import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsService } from './notifications.service';
import { DeviceTokensService } from './device-tokens.service';
import { DjangoUserPrefsClient } from './django-user-prefs.client';
import { DeviceToken, DeviceTokenSchema } from './schemas/device-token.schema';
import { NotificationsController } from './notifications.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([{ name: DeviceToken.name, schema: DeviceTokenSchema }]),
    AuthModule,
  ],
  providers: [NotificationsService, DeviceTokensService, DjangoUserPrefsClient],
  controllers: [NotificationsController],
  exports: [NotificationsService, DeviceTokensService, DjangoUserPrefsClient],
})
export class NotificationsModule {}
