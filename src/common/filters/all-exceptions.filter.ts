import {
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import type { FastifyReply, FastifyRequest } from 'fastify'

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const request = ctx.getRequest<FastifyRequest>()
    const reply = ctx.getResponse<FastifyReply>()

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR

    const isServerError = status >= 500
    const rid = (request?.headers?.['x-request-id'] as string) ?? '-'

    if (isServerError) {
      this.logger.error(
        JSON.stringify({
          event: 'unhandled_exception',
          request_id: rid,
          method: request?.method,
          url: request?.url,
          status,
          err:
            exception instanceof Error
              ? { message: exception.message, stack: exception.stack }
              : String(exception),
        }),
      )
    }

    // For WebSocket (non-HTTP) contexts, delegate to default NestJS handling
    if (host.getType() !== 'http') {
      return super.catch(exception, host)
    }

    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' }

    reply.status(status).send(body)
  }
}
