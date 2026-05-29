import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { AuthModule } from '../auth/auth.module';
import { HttpAuthGuard } from '../auth/http-auth.guard';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [UploadsController],
  providers: [HttpAuthGuard],
})
export class UploadsModule {}
