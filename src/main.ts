// src/main.ts

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';

// ✅ Load .env and expand variables like ${ORIGINS_SERVER}
dotenvExpand.expand(dotenv.config());

// Sentry must be initialised before any other imports so it can instrument them
const _sentryDsn = (process.env.SENTRY_DSN ?? '').trim();
if (_sentryDsn) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn: _sentryDsn,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    environment: process.env.NODE_ENV ?? 'development',
    sendDefaultPii: false,
  });
}

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
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import { requestIdMiddleware } from './observability/request-id.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
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

function hasS3UploadConfig() {
  return Boolean(
    process.env.SUPABASE_S3_ENDPOINT_URL &&
      process.env.SUPABASE_S3_ACCESS_KEY_ID &&
      process.env.SUPABASE_S3_SECRET_ACCESS_KEY &&
      process.env.SUPABASE_S3_BUCKET_NAME,
  );
}

const DEFAULT_MAX_UPLOAD_BYTES = 2_147_483_647
const uploadMaxBytes = () => Number(process.env.UPLOAD_MAX_BYTES) || DEFAULT_MAX_UPLOAD_BYTES

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

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: uploadMaxBytes() },
  });

  if (!hasS3UploadConfig()) {
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
  }

  await app.register(fastifyStatic, {
    root: join(process.cwd(), 'public'),
    prefix: '/',
    index: ['index.html'],
  });

  app.useGlobalFilters(new AllExceptionsFilter());

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
