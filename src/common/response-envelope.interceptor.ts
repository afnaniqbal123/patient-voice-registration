import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';

/**
 * Wraps every successful response in the { data, error } envelope required
 * by the spec, so controllers can just return plain payloads.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((payload) => {
        if (payload && typeof payload === 'object' && 'data' in payload && 'error' in payload) {
          return payload;
        }
        return { data: payload ?? null, error: null };
      }),
    );
  }
}
