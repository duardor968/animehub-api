import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthService', () => {
  it('reports liveness without external dependencies', () => {
    const prisma = {} as PrismaService;
    const service = new HealthService(prisma);

    expect(service.live()).toEqual({
      service: 'animehub-api',
      status: 'live',
      version: '0.1.0',
    });
  });

  it('reports database failures without leaking their details', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockRejectedValue(new Error('secret connection data')),
    } as unknown as PrismaService;
    const service = new HealthService(prisma);

    await expect(service.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
