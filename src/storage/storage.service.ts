// src/storage/storage.service.ts (interface)
import type { Readable } from 'stream';

export type PresignRequest = { filename: string; mime: string; size: number };
export type StoredFile = { key: string; url: string; name: string; mime: string; size: number };
export type StoredFileStream = { body: Readable; mime?: string; size?: number; name?: string };

export abstract class StorageService {
  abstract driver(): 'local' | 's3';
  isPublic(): boolean {
    return false;
  }
  abstract storeLocal(file: {
    buffer: Buffer;
    filename: string;
    mime: string;
    size: number;
    publicBase?: string;
  }): Promise<StoredFile>;
  abstract getFile(key: string): Promise<StoredFileStream>;
  abstract deleteFile(key: string): Promise<void>;

  /** Presigned direct-PUT URL for client-to-storage uploads (server never sees the bytes). */
  abstract generatePresignedPut(key: string, contentType: string, expiresIn: number): Promise<string>;

  /** Verifies what actually landed in storage after a direct-PUT upload, or null if nothing is there. */
  abstract headObjectMeta(key: string): Promise<{ size: number; contentType: string } | null>;

  /** Public (CDN/bucket) URL for a key — only meaningful when isPublic() is true. */
  abstract publicUrlFor(key: string): string;
}
