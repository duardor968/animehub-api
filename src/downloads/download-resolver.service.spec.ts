import { vi } from 'vitest';
import { AnimeService } from '../anime/anime.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AnimeAv1Service,
  AnimeAv1UnavailableError,
} from '../source/animeav1.service';
import {
  DownloadResolverService,
  linkTtlMinutes,
  MISSING_AUDIO_RECHECK_MS,
  selectDownloadLinks,
} from './download-resolver.service';
import { ProviderDto, RequestedAudioDto } from './download.dto';

const DAY = 24 * 60 * 60_000;

describe('download resolution policies', () => {
  const now = Date.UTC(2026, 7, 10, 12);

  it('uses the requested audio when available and otherwise falls back', () => {
    const links = [
      { audio: 'SUB', provider: 'MEGA', url: 'sub' },
      { audio: 'DUB', provider: 'PIXELDRAIN', url: 'dub' },
    ];

    expect(
      selectDownloadLinks(links, RequestedAudioDto.SUB, [ProviderDto.MEGA]),
    ).toEqual([links[0]]);
    expect(
      selectDownloadLinks(links, RequestedAudioDto.SUB, [
        ProviderDto.PIXELDRAIN,
      ]),
    ).toEqual([links[1]]);
    expect(
      selectDownloadLinks(links, RequestedAudioDto.SUB, [
        ProviderDto.MP4UPLOAD,
      ]),
    ).toEqual([]);
  });

  it('caches links a fifth of the time they have been stable', () => {
    const since = (ms: number) => new Date(now - ms);
    expect(linkTtlMinutes(since(60 * 60_000), null, false, now)).toBe(15);
    expect(linkTtlMinutes(since(DAY), null, false, now)).toBe(288);
    expect(linkTtlMinutes(since(5 * DAY), null, false, now)).toBe(24 * 60);
    expect(linkTtlMinutes(since(60 * DAY), null, false, now)).toBe(7 * 24 * 60);
  });

  it('re-probes an episode without links within minutes', () => {
    const stable = new Date(now - 60 * DAY);
    expect(linkTtlMinutes(stable, null, true, now)).toBe(2);
    // A recent episode with no mirrors yet is re-probed almost immediately so a
    // just-published episode recovers as soon as the source populates its links.
    expect(linkTtlMinutes(stable, new Date(now - 60_000), true, now)).toBe(0.5);
    expect(linkTtlMinutes(stable, new Date(now - 5 * DAY), true, now)).toBe(2);
  });
});

describe('DownloadResolverService.resolveEpisode', () => {
  const link = (audio: string, url: string, expiresAt: Date) => ({
    audio,
    provider: 'MEGA',
    url,
    expiresAt,
  });

  function harness({
    links = [] as ReturnType<typeof link>[],
    probe = null as null | {
      fetchedAt: Date;
      expiresAt: Date;
      stableSince: Date;
    },
    publishedAt = null as Date | null,
    createdAt = new Date(Date.now() - 30 * DAY),
    source = vi.fn(),
  }) {
    const episode = {
      id: 'ep-1',
      publishedAt,
      createdAt,
      links,
      downloadProbe: probe,
    };
    const prisma = {
      episode: { findUnique: vi.fn(() => Promise.resolve(episode)) },
      downloadLink: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
        findMany: vi.fn(() => Promise.resolve(links)),
      },
      downloadProbe: { upsert: vi.fn() },
      $transaction: vi.fn(() => Promise.resolve([])),
    };
    const service = new DownloadResolverService(
      prisma as unknown as PrismaService,
      {} as AnimeService,
      { getEpisodeDownloads: source } as unknown as AnimeAv1Service,
    );
    const resolve = (audio = RequestedAudioDto.SUB, deadline?: number) =>
      service.resolveEpisode(
        'anime-1',
        'slug',
        1,
        audio,
        [ProviderDto.MEGA],
        false,
        deadline,
      );
    const stored = () => {
      const call = prisma.downloadProbe.upsert.mock.calls[0] as unknown as [
        { create: { stableSince: Date; expiresAt: Date } },
      ];
      return call[0].create;
    };
    return { resolve, source, prisma, stored };
  }

  const expired = () => ({
    fetchedAt: new Date(Date.now() - 2 * DAY),
    expiresAt: new Date(Date.now() - 60_000),
    stableSince: new Date(Date.now() - 10 * DAY),
  });

  it('serves the stored links when the source fails', async () => {
    const past = new Date(Date.now() - 60_000);
    const { resolve } = harness({
      links: [link('SUB', 'old', past)],
      probe: expired(),
      source: vi.fn(() => Promise.reject(new AnimeAv1UnavailableError('down'))),
    });

    await expect(resolve()).resolves.toMatchObject({
      links: [{ provider: 'MEGA', url: 'old' }],
      errorCode: null,
    });
  });

  it('fails when the source fails and no links are stored', async () => {
    const { resolve } = harness({
      source: vi.fn(() => Promise.reject(new AnimeAv1UnavailableError('down'))),
    });

    await expect(resolve()).rejects.toBeInstanceOf(AnimeAv1UnavailableError);
  });

  it('serves the stored links at the deadline and stores the late refresh', async () => {
    const past = new Date(Date.now() - 60_000);
    let answer!: (value: unknown) => void;
    const source = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { resolve, prisma } = harness({
      links: [link('SUB', 'old', past)],
      probe: expired(),
      source,
    });

    await expect(
      resolve(RequestedAudioDto.SUB, Date.now()),
    ).resolves.toMatchObject({ links: [{ url: 'old' }] });
    // A second request joins the refresh still running.
    await resolve(RequestedAudioDto.SUB, Date.now());
    expect(source).toHaveBeenCalledTimes(1);

    answer({ links: [{ audio: 'SUB', provider: 'MEGA', url: 'new' }] });
    await vi.waitFor(() => expect(prisma.$transaction).toHaveBeenCalled());
  });

  it('re-probes for a missing audio only after an hour', async () => {
    const future = new Date(Date.now() + DAY);
    const probe = (age: number) => ({
      fetchedAt: new Date(Date.now() - age),
      expiresAt: future,
      stableSince: new Date(Date.now() - 10 * DAY),
    });
    const sourceLinks = { links: [] };

    const recent = harness({
      links: [link('SUB', 'sub', future)],
      probe: probe(MISSING_AUDIO_RECHECK_MS - 60_000),
      source: vi.fn(() => Promise.resolve(sourceLinks)),
    });
    await recent.resolve(RequestedAudioDto.DUB);
    expect(recent.source).not.toHaveBeenCalled();

    const old = harness({
      links: [link('SUB', 'sub', future)],
      probe: probe(MISSING_AUDIO_RECHECK_MS),
      source: vi.fn(() => Promise.resolve(sourceLinks)),
    });
    await old.resolve(RequestedAudioDto.DUB);
    expect(old.source).toHaveBeenCalledTimes(1);
    // The audio it has is served from the cache however old.
    await old.resolve(RequestedAudioDto.SUB);
    expect(old.source).toHaveBeenCalledTimes(1);
  });

  it('keeps the stable time while the links stay the same', async () => {
    const past = new Date(Date.now() - 60_000);
    const probe = expired();
    const same = harness({
      links: [link('SUB', 'a', past)],
      probe,
      source: vi.fn(() =>
        Promise.resolve({
          links: [{ audio: 'SUB', provider: 'MEGA', url: 'a' }],
        }),
      ),
    });
    await same.resolve();
    expect(same.stored().stableSince).toEqual(probe.stableSince);
    // Ten days stable: cached for two of them.
    expect(same.stored().expiresAt.getTime() - Date.now()).toBeGreaterThan(
      1.9 * DAY,
    );

    const changed = harness({
      links: [link('SUB', 'a', past)],
      probe: expired(),
      source: vi.fn(() =>
        Promise.resolve({
          links: [
            { audio: 'SUB', provider: 'MEGA', url: 'a' },
            { audio: 'SUB', provider: 'MP4UPLOAD', url: 'b' },
          ],
        }),
      ),
    });
    await changed.resolve();
    expect(Date.now() - changed.stored().stableSince.getTime()).toBeLessThan(
      1000,
    );
  });

  it('assumes a first probe stable since publication or first sight', async () => {
    const publishedAt = new Date(Date.now() - 3 * DAY);
    const createdAt = new Date(Date.now() - 20 * DAY);
    const source = () =>
      vi.fn(() =>
        Promise.resolve({
          links: [{ audio: 'SUB', provider: 'MEGA', url: 'a' }],
        }),
      );

    const dated = harness({ publishedAt, createdAt, source: source() });
    await dated.resolve();
    expect(dated.stored().stableSince).toEqual(publishedAt);

    const undated = harness({ createdAt, source: source() });
    await undated.resolve();
    expect(undated.stored().stableSince).toEqual(createdAt);
  });
});
