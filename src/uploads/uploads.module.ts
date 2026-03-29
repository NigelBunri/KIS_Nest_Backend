import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { LocalStorageService } from '../storage/local-storage.service';

@Module({
  controllers: [UploadsController],
  providers: [LocalStorageService],
})
export class UploadsModule {}
