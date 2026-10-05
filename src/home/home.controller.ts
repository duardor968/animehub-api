import { Controller, Get, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HomeResponseDto } from '../common/contracts';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { HomeService } from './home.service';

@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Get()
  @ApiOperation({ summary: 'Devuelve portada, estrenos y añadidos recientes' })
  @ApiOkResponse({ type: HomeResponseDto })
  @ApiProblemResponses(429, 500, 503)
  getHome(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const incoming = request.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    reply.header('x-request-id', requestId);
    return this.homeService.getHome(requestId);
  }
}
