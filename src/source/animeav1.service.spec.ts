import { ConfigService } from '@nestjs/config';
import { stringify } from 'devalue';
import { vi } from 'vitest';
import { AnimeAv1Service } from './animeav1.service';

function routeResponse(data: unknown) {
  return new Response(
    JSON.stringify({
      type: 'data',
      nodes: [{ type: 'data', data: JSON.parse(stringify(data)) as unknown }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('AnimeAv1Service', () => {
  const service = new AnimeAv1Service(
    new ConfigService({ ANIMEAV1_BASE_URL: 'https://source.test' }),
  );

  afterEach(() => vi.restoreAllMocks());

  it('decodes and normalizes SvelteKit route data without HTML', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      routeResponse({
        featured: [
          {
            id: 7,
            slug: 'sample-anime',
            title: 'Sample Anime',
            synopsis: '  Synopsis  ',
            status: 2,
            startDate: '2026-01-02T00:00:00.000Z',
            mature: true,
            category: { id: 1, name: 'TV Anime', slug: 'tv' },
            genres: [{ id: 3, name: 'Acción' }],
          },
        ],
        latestEpisodes: [],
        latestMedia: [],
      }),
    );

    const home = await service.getHome();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://source.test/__data.json',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(home.featured[0]).toMatchObject({
      id: '7',
      slug: 'sample-anime',
      synopsis: 'Synopsis',
      status: 'AIRING',
      mature: true,
      posterUrl: 'https://cdn.animeav1.com/covers/7.jpg',
      genres: [{ id: '3', name: 'Acción', slug: 'accion' }],
    });
  });

  it('keeps only supported providers and audio variants', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      routeResponse({
        media: { id: 7, slug: 'sample-anime', title: 'Sample Anime' },
        episode: { id: 70, number: 1 },
        downloads: {
          SUB: [
            { server: 'MEGA', url: 'https://mega.nz/file/example' },
            { server: 'Unknown', url: 'https://example.com/file' },
          ],
          dub: [
            { server: 'PixelDrain', url: 'https://pixeldrain.com/u/example' },
          ],
          LAT: [{ server: 'MEGA', url: 'https://mega.nz/file/ignored' }],
        },
      }),
    );

    const result = await service.getEpisodeDownloads('sample-anime', 1);

    expect(result.links).toEqual([
      {
        audio: 'SUB',
        provider: 'MEGA',
        url: 'https://mega.nz/file/example',
      },
      {
        audio: 'DUB',
        provider: 'PIXELDRAIN',
        url: 'https://pixeldrain.com/u/example',
      },
    ]);
  });
});
