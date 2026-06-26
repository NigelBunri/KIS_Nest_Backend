// src/storage/s3-storage.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageService, StoredFile, StoredFileStream } from './storage.service';

const env = (...names: string[]) => {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
};

const requiredEnv = (...names: string[]) => {
  const value = env(...names);
  if (!value) throw new Error(`${names[0]} is required for S3 uploads.`);
  return value;
};

@Injectable()
export class S3StorageService extends StorageService {
  private readonly bucket = requiredEnv('AWS_STORAGE_BUCKET_NAME', 'AWS_S3_BUCKET_NAME', 'SUPABASE_S3_BUCKET_NAME');
  private readonly endpoint = env('AWS_S3_ENDPOINT_URL', 'SUPABASE_S3_ENDPOINT_URL').replace(/\/+$/, '');
  private readonly publicBucket = env('AWS_S3_PUBLIC_BUCKET') === '1' || env('AWS_S3_PUBLIC_BUCKET').toLowerCase() === 'true';
  private readonly publicBase = this.resolvePublicBase();
  private readonly client = new S3Client({
    region: env('AWS_S3_REGION_NAME', 'SUPABASE_S3_REGION_NAME') || 'eu-west-2',
    endpoint: this.endpoint || undefined,
    forcePathStyle: env('AWS_S3_FORCE_PATH_STYLE') === '1' || Boolean(this.endpoint),
    credentials: {
      accessKeyId: requiredEnv('AWS_ACCESS_KEY_ID', 'SUPABASE_S3_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('AWS_SECRET_ACCESS_KEY', 'SUPABASE_S3_SECRET_ACCESS_KEY'),
    },
  });

  driver(): 'local' | 's3' {
    return 's3';
  }

  isPublic(): boolean {
    return this.publicBucket;
  }

  async storeLocal(file: {
    buffer: Buffer;
    filename: string;
    mime: string;
    size: number;
  }): Promise<StoredFile> {
    const safeName = file.filename.replace(/[^\w.\-]+/g, '_');
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mime || 'application/octet-stream',
        ContentLength: file.size,
      }),
    );

    return {
      key,
      url: `${this.publicBase}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
      name: file.filename,
      mime: file.mime || 'application/octet-stream',
      size: file.size,
    };
  }

  async deleteFile(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getFile(key: string): Promise<StoredFileStream> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!(result.Body instanceof Readable)) {
        throw new NotFoundException('File not found.');
      }
      return {
        body: result.Body,
        mime: result.ContentType,
        size: result.ContentLength,
        name: key.split('/').pop(),
      };
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name?: string }).name === 'NoSuchKey') {
        throw new NotFoundException('File not found.');
      }
      throw error;
    }
  }

  private resolvePublicBase() {
    const explicit = env('AWS_S3_PUBLIC_URL', 'SUPABASE_S3_PUBLIC_URL');
    if (explicit) return explicit.replace(/\/+$/, '');
    if (this.endpoint.endsWith('/s3')) {
      return `${this.endpoint.slice(0, -3)}/object/public/${this.bucket}`;
    }
    if (this.endpoint) {
      return `${this.endpoint}/object/public/${this.bucket}`;
    }
    return `https://${this.bucket}.s3.${env('AWS_S3_REGION_NAME', 'SUPABASE_S3_REGION_NAME') || 'eu-west-2'}.amazonaws.com`;
  }
}
