import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  live() {
    return {
      service: 'animehub-api',
      status: 'live',
      version: '0.1.0',
    } as const;
  }

  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        checks: { database: 'up' },
        status: 'ready',
      } as const;
    } catch {
      throw new ServiceUnavailableException({
        checks: { database: 'down' },
        status: 'unavailable',
      });
    }
  }
}
