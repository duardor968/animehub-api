import { ConfigService } from '@nestjs/config';
import { stringify } from 'devalue';
import { vi } from 'vitest';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
  AnimeAv1UnavailableError,
} from './animeav1.service';

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
        latestEpisodes: [
          {
            id: 71,
            number: 4,
            media: {
              id: 7,
              slug: 'sample-anime',
              title: 'Sample Anime',
            },
          },
        ],
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
    expect(home.recentEpisodes[0]?.episode).toMatchObject({
      id: '71',
      number: 4,
      imageUrl: 'https://cdn.animeav1.com/screenshots/7/4.jpg',
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

describe('AnimeAv1Service bounded home source', () => {
  const service = new AnimeAv1Service(
    new ConfigService({ ANIMEAV1_BASE_URL: 'https://source.test' }),
  );
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retains independently valid sections when another section is malformed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      routeResponse({
        featured: 'broken upstream payload',
        latestEpisodes: [
          { id: 10, number: 1, media: { id: 1, slug: 'one', title: 'One' } },
        ],
        latestMedia: [{ id: 2, slug: 'two', title: 'Two' }],
      }),
    );
    const home = await service.getHome();
    expect(home.featured).toEqual([]);
    expect(home.recentEpisodes).toHaveLength(1);
    expect(home.recentAnime).toHaveLength(1);
  });

  it('rejects duplicated entries in one section without blanking valid sections', async () => {
    const anime = { id: 1, slug: 'one', title: 'One' };
    vi.spyOn(global, 'fetch').mockResolvedValue(
      routeResponse({
        featured: [anime, anime],
        latestEpisodes: [],
        latestMedia: [anime],
      }),
    );
    const home = await service.getHome();
    expect(home.featured).toEqual([]);
    expect(home.recentAnime).toHaveLength(1);
  });

  it('does not issue a fetch for an already aborted refresh', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    const controller = new AbortController();
    controller.abort();
    await expect(service.getHome(controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only two attempts and cancels non-success response bodies', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => Promise.resolve());
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      status: 503,
      ok: false,
      body: { cancel },
    } as unknown as Response);
    const result = service.getHome().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('aborts a stalled JSON body, without retrying after cancellation', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockImplementation((_url, init) => {
        const signal = init!.signal!;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () =>
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error('Aborted'),
                  ),
                {
                  once: true,
                },
              );
            }),
        } as unknown as Response);
      });
    const result = service
      .getHome(controller.signal)
      .catch((error: unknown) => error);
    await new Promise<void>((done) => setImmediate(done));
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AnimeAv1Service route errors', () => {
  const service = new AnimeAv1Service(
    new ConfigService({ ANIMEAV1_BASE_URL: 'https://source.test' }),
  );
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Verbatim shape of https://animeav1.com/media/<unknown>/__data.json: HTTP
  // 200, a layout data node, and the page's load() error(404) as the leaf.
  const unknownSlugEnvelope = () =>
    new Response(
      JSON.stringify({
        type: 'data',
        nodes: [
          null,
          { type: 'data', data: [{ user: 1 }, null] },
          {
            type: 'error',
            error: { message: 'Titulo no encontrado' },
            status: 404,
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('maps an error(404) route node to not found, without retrying', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(unknownSlugEnvelope()));

    await expect(service.getAnime('zz-no-existe')).rejects.toBeInstanceOf(
      AnimeAv1NotFoundError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats other route errors and payload drift as unavailability', async () => {
    vi.useFakeTimers();
    vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'data',
            nodes: [{ type: 'error', error: { message: 'boom' }, status: 500 }],
          }),
          { status: 200 },
        ),
      ),
    );
    const routeError = service.getAnime('one-piece').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await routeError).toBeInstanceOf(AnimeAv1UnavailableError);

    vi.spyOn(global, 'fetch').mockResolvedValue(
      routeResponse({ media: { id: 1, slug: 'one-piece' } }),
    );
    await expect(service.getAnime('one-piece')).rejects.toBeInstanceOf(
      AnimeAv1UnavailableError,
    );
  });
});
