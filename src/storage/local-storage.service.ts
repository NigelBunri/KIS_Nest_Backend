// src/storage/local-storage.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { StorageService, StoredFile, StoredFileStream } from './storage.service';
import { createReadStream, createWriteStream, existsSync, unlinkSync } from 'fs';
import { stat } from 'fs/promises';
import { join, normalize, resolve } from 'path';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

const LOCAL_PRESIGN_SECRET =
  process.env.UPLOAD_LOCAL_PRESIGN_SECRET ||
  process.env.DJANGO_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'kis-local-dev-presign-secret';

/**
 * Dev-mode stand-in for S3's presigned-PUT signature: an HMAC over
 * `key.expiry`, verified by UploadsController's `PUT /uploads/local-put`
 * route instead of the usual bearer-auth guard — a presigned URL is meant
 * to be its own credential, same principle as the real S3 signature.
 */
export function signLocalPresignToken(key: string, expiresAtMs: number): string {
  const payload = `${key}.${expiresAtMs}`;
  const mac = createHmac('sha256', LOCAL_PRESIGN_SECRET).update(payload).digest('hex');
  return `${expiresAtMs}.${mac}`;
}

export function verifyLocalPresignToken(key: string, token: string): boolean {
  const [expiresAtRaw, mac] = String(token || '').split('.');
  const expiresAtMs = Number(expiresAtRaw);
  if (!expiresAtMs || !mac || Date.now() > expiresAtMs) return false;
  const expectedMac = createHmac('sha256', LOCAL_PRESIGN_SECRET)
    .update(`${key}.${expiresAtMs}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expectedMac, 'hex');
  const actualBuf = Buffer.from(mac, 'hex');
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

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
      const metaPath = this.metaPathForKey(key);
      if (existsSync(metaPath)) unlinkSync(metaPath);
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

    return {
      key,
      url: this.publicUrlFor(key, file.publicBase),
      name: file.filename,
      mime: file.mime || 'application/octet-stream',
      size: file.size,
    };
  }

  publicUrlFor(key: string, publicBase?: string): string {
    const base = publicBase || process.env.PUBLIC_BASE || 'http://localhost:4000/uploads';
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private originBase(): string {
    // PUBLIC_BASE already points at .../uploads for GET links; strip that
    // suffix to get the server origin the local-put route lives under.
    const configured = process.env.PUBLIC_BASE || 'http://localhost:4000/uploads';
    return configured.replace(/\/uploads\/?$/, '');
  }

  private metaPathForKey(key: string) {
    return `${this.pathForKey(key)}.meta.json`;
  }

  async generatePresignedPut(key: string, _contentType: string, expiresIn: number): Promise<string> {
    const expiresAtMs = Date.now() + expiresIn * 1000;
    const token = signLocalPresignToken(key, expiresAtMs);
    const params = new URLSearchParams({ key, token });
    return `${this.originBase()}/uploads/local-put?${params.toString()}`;
  }

  /** Used by UploadsController's `PUT /uploads/local-put` route once the client's
   * direct-PUT bytes arrive — not part of the abstract StorageService contract
   * since S3 has no equivalent (S3 receives the bytes directly, never through Nest). */
  async writeDirectPut(key: string, buffer: Buffer, contentType: string): Promise<void> {
    const absPath = this.pathForKey(key);
    const fs = await import('fs/promises');
    await fs.mkdir(join(this.uploadsRoot(), key.substring(0, key.lastIndexOf('/')) || '.'), {
      recursive: true,
    }).catch(() => {});
    await new Promise<void>((resolvePromise, reject) => {
      const ws = createWriteStream(absPath);
      ws.on('error', reject);
      ws.on('finish', resolvePromise);
      ws.end(buffer);
    });
    await fs.writeFile(
      this.metaPathForKey(key),
      JSON.stringify({ contentType: contentType || 'application/octet-stream', size: buffer.length }),
    );
  }

  async headObjectMeta(key: string): Promise<{ size: number; contentType: string } | null> {
    const absolutePath = this.pathForKey(key);
    if (!existsSync(absolutePath)) return null;
    const stats = await stat(absolutePath);
    let contentType = 'application/octet-stream';
    try {
      const fs = await import('fs/promises');
      const raw = await fs.readFile(this.metaPathForKey(key), 'utf8');
      contentType = JSON.parse(raw)?.contentType || contentType;
    } catch {
      /* no sidecar — fall back to a generic content type */
    }
    return { size: stats.size, contentType };
  }
}
