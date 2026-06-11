// src/storage/local-storage.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { StorageService, StoredFile, StoredFileStream } from './storage.service';
import { createReadStream, createWriteStream, existsSync, unlinkSync } from 'fs';
import { join, normalize, resolve } from 'path';
import { randomUUID } from 'crypto';

@Injectable()
export class LocalStorageService extends StorageService {
  driver(): 'local' | 's3' {
    return 'local';
  }

  uploadsRoot() {
    return resolve(process.cwd(), process.env.UPLOADS_DIR || 'uploads');
  }

  pathForKey(key: string) {
    const normalized = normalize(String(key || '')).replace(
      /^(\.\.(\/|\\|$))+/,
      '',
    );
    const root = this.uploadsRoot();
    const absolute = resolve(root, normalized);
    if (absolute !== root && !absolute.startsWith(`${root}/`)) {
      throw new Error('Invalid upload key.');
    }
    return absolute;
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const absolutePath = this.pathForKey(key);
      if (existsSync(absolutePath)) unlinkSync(absolutePath);
    } catch { /* ignore */ }
  }

  async getFile(key: string): Promise<StoredFileStream> {
    const absolutePath = this.pathForKey(key);
    if (!existsSync(absolutePath)) {
      throw new NotFoundException('File not found.');
    }
    return { body: createReadStream(absolutePath) };
  }

  async storeLocal(file: {
    buffer: Buffer;
    filename: string;
    mime: string;
    size: number;
    publicBase?: string;
  }): Promise<StoredFile> {
    const safeName = file.filename.replace(/[^\w.\-]+/g, '_'); // sanitize
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}`;
    const absPath = this.pathForKey(key);
    // ensure subdirs
    await import('fs/promises').then((fs) =>
      fs
        .mkdir(join(this.uploadsRoot(), key.substring(0, 10)), {
          recursive: true,
        })
        .catch(() => {}),
    );
    // write
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(absPath);
      ws.on('error', reject);
      ws.on('finish', resolve);
      ws.end(file.buffer);
    });

    const base =
      file.publicBase ||
      process.env.PUBLIC_BASE ||
      'http://localhost:4000/uploads';
    return {
      key,
      url: `${base}/${key.split('/').map(encodeURIComponent).join('/')}`,
      name: file.filename,
      mime: file.mime || 'application/octet-stream',
      size: file.size,
    };
  }
}
