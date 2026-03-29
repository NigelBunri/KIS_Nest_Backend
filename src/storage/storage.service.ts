// src/storage/storage.service.ts (interface)
export type PresignRequest = { filename: string; mime: string; size: number };
export type StoredFile = { key: string; url: string; name: string; mime: string; size: number };

export abstract class StorageService {
  abstract driver(): 'local' | 's3';
  abstract storeLocal(file: { buffer: Buffer; filename: string; mime: string; size: number }): Promise<StoredFile>;
  // Future: abstract presign(req: PresignRequest): Promise<PresignResult>; // for S3
}
