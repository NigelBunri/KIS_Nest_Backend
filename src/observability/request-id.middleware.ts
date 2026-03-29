import { randomUUID } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export function requestIdMiddleware(req: FastifyRequest, res: FastifyReply, next: () => void) {
  const incoming = (req.headers['x-request-id'] as string | undefined) ?? '';
  const id = incoming || randomUUID();
  (req as any).requestId = id;
  const replyAny = res as any;
  if (typeof replyAny.header === 'function') {
    replyAny.header('x-request-id', id);
  } else if (typeof replyAny.setHeader === 'function') {
    replyAny.setHeader('x-request-id', id);
  }
  next();
}
