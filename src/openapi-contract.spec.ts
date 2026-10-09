import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';

const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8'),
) as OpenAPIObject;

function queryNames(path: string) {
  const operation = document.paths[path]?.get;
  if (!operation) throw new Error(`Missing GET ${path}`);
  return (operation.parameters ?? [])
    .flatMap((parameter) =>
      '$ref' in parameter || parameter.in !== 'query' ? [] : [parameter.name],
    )
    .sort();
}

describe('generated OpenAPI contract', () => {
  it('documents every catalog and episode query parameter', () => {
    expect(queryNames('/api/v1/catalog')).toEqual(
      [
        'category',
        'genre',
        'letter',
        'maxYear',
        'minYear',
        'order',
        'page',
        'search',
        'status',
      ].sort(),
    );
    expect(queryNames('/api/v1/catalog/suggestions')).toEqual(['q']);
    expect(queryNames('/api/v1/anime/{slug}/episodes')).toEqual(['page']);
  });

  it('publishes production/local servers and an opaque job capability', () => {
    expect(document.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'https://animehub-api.duardo.dev' }),
        expect.objectContaining({ url: 'http://localhost:8000' }),
      ]),
    );
    expect(document.components?.securitySchemes?.jobCapability).toEqual(
      expect.objectContaining({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'opaque capability',
      }),
    );
  });

  it('documents Problem Details instead of only success responses', () => {
    const responses = document.paths['/api/v1/catalog']?.get?.responses;
    expect(responses?.[400]).toMatchObject({
      content: {
        'application/problem+json': {
          schema: { $ref: '#/components/schemas/ProblemDetailsDto' },
        },
      },
    });
    expect(responses?.[503]).toBeDefined();
    expect(
      document.paths['/api/v1/health/ready']?.get?.responses?.[200],
    ).toBeDefined();
  });

  it('documents the UI support additions', () => {
    const schemas = document.components?.schemas ?? {};
    const schema = (name: string) =>
      schemas[name] as { required?: string[]; properties?: object };
    expect(schema('CatalogMetaDto').required).toContain('capped');
    expect(schema('EpisodePageMetaDto').required).toEqual(
      expect.arrayContaining(['firstNumber', 'lastNumber']),
    );
    expect(schema('DownloadJobReceiptDto').required).toContain(
      'missingEpisodeNumbers',
    );
    expect(
      document.paths['/api/v1/anime/{slug}/download-jobs']?.post?.requestBody,
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            discriminator: {
              propertyName: 'scope',
              mapping: {
                ALL: '#/components/schemas/AllDownloadJobRequestDto',
                RANGE: '#/components/schemas/RangeDownloadJobRequestDto',
                EPISODES: '#/components/schemas/EpisodesDownloadJobRequestDto',
              },
            },
          },
        },
      },
    });
    expect(schema('RangeDownloadJobRequestDto').required).toEqual(
      expect.arrayContaining(['from', 'to']),
    );
    expect(schema('EpisodesDownloadJobRequestDto').required).toContain(
      'episodeNumbers',
    );
    expect(
      document.paths['/api/v1/sitemap/anime']?.get?.responses?.[200],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/SitemapAnimeResponseDto' },
        },
      },
    });
  });

  it('documents the optional Idempotency-Key of job creation', () => {
    const operation =
      document.paths['/api/v1/anime/{slug}/download-jobs']?.post;
    const headers = (operation?.parameters ?? []).filter(
      (parameter) => !('$ref' in parameter) && parameter.in === 'header',
    );
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({
      name: 'idempotency-key',
      required: false,
      schema: { minLength: 16, maxLength: 128 },
    });
    expect(operation?.responses?.[409]).toBeDefined();
    expect(operation?.responses?.[422]).toBeDefined();
  });

  it('documents Retry-After on every 429', () => {
    const limited = Object.values(document.paths).flatMap((item) =>
      Object.values(item ?? {}).flatMap((operation: unknown) => {
        const responses = (
          operation as { responses?: Record<string, { headers?: object }> }
        ).responses;
        return responses?.[429] ? [responses[429]] : [];
      }),
    );
    expect(limited.length).toBeGreaterThan(5);
    for (const response of limited) {
      expect(response.headers).toHaveProperty('Retry-After');
    }
  });
});
