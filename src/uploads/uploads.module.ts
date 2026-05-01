import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { LocalStorageService } from '../storage/local-storage.service';
import { AuthModule } from '../auth/auth.module';
import { HttpAuthGuard } from '../auth/http-auth.guard';

@Module({
  imports: [AuthModule],
  controllers: [UploadsController],
  providers: [LocalStorageService, HttpAuthGuard],
})
export class UploadsModule {}
