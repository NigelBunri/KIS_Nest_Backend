// src/main.ts

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

// ✅ add this (adjust path if needed)
import { requestIdMiddleware } from './observability/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // ✅ request id for every HTTP request (used by HttpLoggingInterceptor)
  app.use(requestIdMiddleware);

  const origins = (process.env.ORIGINS ?? '').split(',').filter(Boolean);
  await app.register(fastifyCors, {
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    credentials: true,
  });

  // multipart for local uploads
  await app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
  });

  // ensure uploads dir exists
  const uploadsDir = process.env.UPLOADS_DIR || 'uploads';
  const absUploads = join(process.cwd(), uploadsDir);
  if (!existsSync(absUploads)) mkdirSync(absUploads, { recursive: true });

  // serve /uploads/* statically
  await app.register(fastifyStatic, {
    root: absUploads,
    prefix: '/uploads/', // -> http://localhost:4000/uploads/<file>
    index: false,
    decorateReply: false,
  });

  // serve your /public page (unchanged)
  await app.register(fastifyStatic, {
    root: join(process.cwd(), 'public'),
    prefix: '/',
    index: ['index.html'],
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true }),
  );

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
}
bootstrap();
