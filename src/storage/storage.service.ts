// src/storage/storage.service.ts (interface)
import type { Readable } from 'stream';

export type PresignRequest = { filename: string; mime: string; size: number };
export type StoredFile = { key: string; url: string; name: string; mime: string; size: number };
export type StoredFileStream = { body: Readable; mime?: string; size?: number; name?: string };

export abstract class StorageService {
  abstract driver(): 'local' | 's3';
  abstract storeLocal(file: {
    buffer: Buffer;
    filename: string;
    mime: string;
    size: number;
    publicBase?: string;
  }): Promise<StoredFile>;
  abstract getFile(key: string): Promise<StoredFileStream>;
  abstract deleteFile(key: string): Promise<void>;
}
