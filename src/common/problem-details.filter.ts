import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  AnimeAv1NotFoundError,
  AnimeAv1UnavailableError,
} from '../source/animeav1.service';

function hasHttpStatusCode(
  error: unknown,
): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  );
}

/**
 * Normalizes anything thrown into an HttpException; `null` means a genuine
 * internal error (500). Upstream failures become 404/503, and errors raised by
 * Fastify plugins/parsers keep the status they carry: Nest's Fastify adapter
 * only maps errors named `FastifyError`, so e.g. @fastify/rate-limit's 429 or a
 * JSON body SyntaxError (400) would otherwise surface as 500.
 */
export function toHttpException(exception: unknown): HttpException | null {
  if (exception instanceof HttpException) return exception;
  if (exception instanceof AnimeAv1NotFoundError) {
    return new NotFoundException('The resource does not exist at the source.');
  }
  if (exception instanceof AnimeAv1UnavailableError) {
    return new ServiceUnavailableException(
      'AnimeAV1 is temporarily unavailable.',
    );
  }
  if (hasHttpStatusCode(exception)) {
    return new HttpException(
      exception.statusCode < 500
        ? exception.message
        : 'The request could not be completed.',
      exception.statusCode,
    );
  }
  return null;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    const httpException = toHttpException(exception);
    const status = httpException
      ? httpException.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = httpException ? httpException.getResponse() : null;
    const detail =
      typeof payload === 'string'
        ? payload
        : payload && typeof payload === 'object' && 'message' in payload
          ? Array.isArray(payload.message)
            ? payload.message.join('; ')
            : String(payload.message)
          : status === 500
            ? 'The server could not complete the request.'
            : 'The request could not be completed.';

    if (status === 500) {
      this.logger.error(
        `${request.method} ${request.url} failed`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (status > 500) {
      this.logger.warn(
        `${request.method} ${request.url} answered ${status}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    }

    const responseTitle =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : (HttpStatus[status] ?? 'Error')
            .toLowerCase()
            .replaceAll('_', ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());

    void response
      .header('content-type', 'application/problem+json; charset=utf-8')
      .status(status)
      .send({
        type: `https://animehub.dev/problems/${HttpStatus[status]?.toLowerCase() ?? 'error'}`,
        title: responseTitle,
        status,
        detail,
        instance: request.url,
        requestId: request.id,
      });
  }
}
