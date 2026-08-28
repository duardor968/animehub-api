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
});
