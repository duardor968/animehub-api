import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Comprueba que el proceso del API está activo' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['service', 'status', 'version'],
      properties: {
        service: { type: 'string', example: 'animehub-api' },
        status: { type: 'string', enum: ['live'] },
        version: { type: 'string', example: '0.1.0' },
      },
    },
  })
  live() {
    return this.healthService.live();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Comprueba que PostgreSQL está disponible' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['checks', 'status'],
      properties: {
        checks: {
          type: 'object',
          required: ['database'],
          properties: { database: { type: 'string', enum: ['up'] } },
        },
        status: { type: 'string', enum: ['ready'] },
      },
    },
  })
  @ApiProblemResponses(500, 503)
  ready() {
    return this.healthService.ready();
  }
}
