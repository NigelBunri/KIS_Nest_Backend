// src/main.ts

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';

// ✅ Load .env and expand variables like ${ORIGINS_SERVER}
dotenvExpand.expand(dotenv.config());

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import { requestIdMiddleware } from './observability/request-id.middleware';
import {
  configuredOrigins,
  fastifyCorsOriginDelegate,
} from './security/origin-policy';

function isWeakSecret(value: string | undefined) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  if (text.length < 40) return true;
  if (new Set(text).size < 5) return true;
  return [
    'dev-secret',
    'dev-internal-secret',
    'change-me',
    'password',
  ].includes(text);
}

function assertProductionSecurityConfig() {
  if ((process.env.NODE_ENV ?? '').toLowerCase() !== 'production') return;

  const missing: string[] = [];
  const weak: string[] = [];
  const required = [
    'ORIGINS',
    'DJANGO_INTROSPECT_URL',
    'DJANGO_INTERNAL_TOKEN',
    'DJANGO_JWT_SECRET',
    'MONGODB_URI',
  ];

  for (const key of required) {
    if (!String(process.env[key] ?? '').trim()) missing.push(key);
  }
  for (const key of ['DJANGO_INTERNAL_TOKEN', 'DJANGO_JWT_SECRET']) {
    if (isWeakSecret(process.env[key])) weak.push(key);
  }

  if ((process.env.DJANGO_TLS_INSECURE ?? '0') === '1') {
    weak.push('DJANGO_TLS_INSECURE');
  }

  const origins = configuredOrigins();
  if (
    origins.some((origin) => origin === '*' || origin.startsWith('http://'))
  ) {
    weak.push('ORIGINS');
  }

  if (missing.length || weak.length) {
    throw new Error(
      `Refusing insecure production startup. Missing: ${missing.join(', ') || 'none'}. Weak/unsafe: ${weak.join(', ') || 'none'}.`,
    );
  }
}

function shouldServeUploadsPublicly() {
  const explicit = String(process.env.SERVE_UPLOADS_PUBLICLY ?? '').trim();
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return (process.env.NODE_ENV ?? '').toLowerCase() !== 'production';
}

async function bootstrap() {
  assertProductionSecurityConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  app.use(requestIdMiddleware);

  await app.register(fastifyCors, {
    origin: fastifyCorsOriginDelegate,
    credentials: true,
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  const uploadsDir = process.env.UPLOADS_DIR || 'uploads';
  const absUploads = join(process.cwd(), uploadsDir);

  if (!existsSync(absUploads)) {
    mkdirSync(absUploads, { recursive: true });
  }

  if (shouldServeUploadsPublicly()) {
    await app.register(fastifyStatic, {
      root: absUploads,
      prefix: '/uploads/',
      index: false,
      decorateReply: false,
    });
  }

  await app.register(fastifyStatic, {
    root: join(process.cwd(), 'public'),
    prefix: '/',
    index: ['index.html'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: true,
    }),
  );

  const port = Number(process.env.PORT ?? 4000);

  await app.listen({ port, host: '0.0.0.0' });
}

bootstrap();
