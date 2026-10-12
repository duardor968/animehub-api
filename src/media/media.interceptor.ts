import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { mergeMap, Observable } from 'rxjs';
import { MediaService } from './media.service';

/** Every response leaves with its images localized (see MediaService). */
@Injectable()
export class MediaInterceptor implements NestInterceptor {
  constructor(private readonly media: MediaService) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(mergeMap((body) => this.media.localize(body)));
  }
}
