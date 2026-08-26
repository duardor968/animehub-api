import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { Observable } from 'rxjs';

export const API_CACHE_CONTROL = 'private, no-store, max-age=0';

@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    context
      .switchToHttp()
      .getResponse<FastifyReply>()
      .header('Cache-Control', API_CACHE_CONTROL);
    return next.handle();
  }
}
