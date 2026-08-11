import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload =
      exception instanceof HttpException ? exception.getResponse() : null;
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

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} failed`,
        exception instanceof Error ? exception.stack : undefined,
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
