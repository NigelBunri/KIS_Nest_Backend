// src/storage/storage.module.ts
import { Module } from '@nestjs/common';
import { LocalStorageService } from './local-storage.service';
import { S3StorageService } from './s3-storage.service';
import { StorageService } from './storage.service';

const hasS3Config = () =>
  Boolean(
    (process.env.AWS_ACCESS_KEY_ID || process.env.SUPABASE_S3_ACCESS_KEY_ID) &&
      (process.env.AWS_SECRET_ACCESS_KEY || process.env.SUPABASE_S3_SECRET_ACCESS_KEY) &&
      (process.env.AWS_STORAGE_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || process.env.SUPABASE_S3_BUCKET_NAME),
  );

@Module({
  providers: [
    LocalStorageService,
    {
      provide: StorageService,
      useFactory: (local: LocalStorageService) =>
        hasS3Config() ? new S3StorageService() : local,
      inject: [LocalStorageService],
    },
  ],
  exports: [StorageService, LocalStorageService],
})
export class StorageModule {}
