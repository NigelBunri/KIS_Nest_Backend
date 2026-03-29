import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const req: any = ctx.getRequest();
    const res: any = ctx.getResponse();

    const method = req?.method;
    const url = req?.url;
    const rid = req?.requestId;

    const start = Date.now();
    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - start;
        const code = res?.statusCode;
        this.logger.log(`${method} ${url} ${code} ${ms}ms rid=${rid ?? '-'}`);
      }),
    );
  }
}
