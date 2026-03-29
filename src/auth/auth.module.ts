import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DjangoAuthService } from './django-auth.service';

@Module({
  imports: [ConfigModule],
  providers: [DjangoAuthService],
  exports: [DjangoAuthService],
})
export class AuthModule {}
