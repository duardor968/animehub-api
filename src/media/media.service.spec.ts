import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { vi } from 'vitest';
import { serializeAnime, serializeEpisode } from '../common/serializers';
import { MediaAssetStatus } from '../generated/prisma/enums';
import { JobQueue } from '../jobs/job-queue';
import { PrismaService } from '../prisma/prisma.service';
import { MEDIA_CACHE_CONTROL, MediaService, toWebp } from './media.service';

const CDN = 'https://cdn.animeav1.com';
const STORAGE = {
  MEDIA_S3_ENDPOINT: 'http://127.0.0.1:9000',
  MEDIA_S3_REGION: 'us-east-1',
  MEDIA_S3_ACCESS_KEY_ID: 'test-access',
  MEDIA_S3_SECRET_ACCESS_KEY: 'test-secret',
  MEDIA_S3_BUCKET: 'animehub-media',
  MEDIA_PUBLIC_URL: 'https://media.test/animehub-media/',
};

// A 1200×252 backdrop: narrower than the widest stored width.
const fixture = () =>
  sharp({
    create: {
      width: 1200,
      height: 252,
      channels: 3,
      background: { r: 200, g: 80, b: 40 },
    },
  })
    .jpeg()
    .toBuffer();

function harness(settings: Record<string, string> = STORAGE) {
  const prisma = {
    mediaAsset: {
      findMany: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
      findUnique: vi.fn((): Promise<unknown> => Promise.resolve(null)),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  };
  const boss = { work: vi.fn(), insert: vi.fn() };
  const service = new MediaService(
    new ConfigService({ SOURCE_USER_AGENT: 'AnimeHub/test', ...settings }),
    prisma as unknown as PrismaService,
    { open: () => Promise.resolve(boss) } as unknown as JobQueue,
  );
  return { service, prisma, boss };
}

const animeRecord = {
  sourceId: '42',
  slug: 'sample',
  title: 'Sample',
  synopsis: null,
  posterUrl: `${CDN}/covers/42.jpg`,
  backdropUrl: `${CDN}/backdrops/42.jpg`,
  status: 'AIRING',
  category: null,
  startDate: null,
  mature: false,
};
const episodeRecord = {
  sourceId: '420',
  number: 12.5,
  title: null,
  imageUrl: `${CDN}/screenshots/42/12.5.jpg`,
  publishedAt: null,
};
const response = () => ({
  data: [
    {
      anime: serializeAnime(animeRecord),
      episode: serializeEpisode(episodeRecord),
    },
    {
      anime: serializeAnime(animeRecord),
      episode: serializeEpisode(episodeRecord),
    },
  ],
});

describe('toWebp', () => {
  it('stores each width once, as WebP, never wider than the source', async () => {
    const variants = await toWebp(await fixture(), [640, 1280, 1900]);

    expect(variants.map(({ width }) => width)).toEqual([640, 1200]);
    for (const { width, body } of variants) {
      const metadata = await sharp(body).metadata();
      expect(metadata).toMatchObject({
        format: 'webp',
        width,
        height: Math.round((252 * width) / 1200),
      });
    }
  });
});

describe('MediaService.localize', () => {
  it('serves source URLs untouched when the storage is not configured', async () => {
    const h = harness({ MEDIA_S3_BUCKET: 'animehub-media' });
    await h.service.onModuleInit();
    const body = response();

    await expect(h.service.localize(body)).resolves.toEqual(response());
    expect(h.prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    expect(h.boss.work).not.toHaveBeenCalled();
  });

  it('keeps unconverted images and queues each of them once', async () => {
    const h = harness();
    await h.service.onModuleInit();

    const body = await h.service.localize(response());

    expect(body).toEqual(response());
    expect(body.data[0].anime.backdropSrcSet).toBeNull();
    expect(h.prisma.mediaAsset.findMany).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.boss.insert).toHaveBeenCalledOnce());
    expect(h.boss.insert).toHaveBeenCalledWith('animehub-media', [
      {
        data: { url: `${CDN}/covers/42.jpg` },
        singletonKey: `${CDN}/covers/42.jpg`,
      },
      {
        data: { url: `${CDN}/backdrops/42.jpg` },
        singletonKey: `${CDN}/backdrops/42.jpg`,
      },
      {
        data: { url: `${CDN}/screenshots/42/12.5.jpg` },
        singletonKey: `${CDN}/screenshots/42/12.5.jpg`,
      },
    ]);
  });

  it('points ready images at their WebP copies, with a backdrop srcset', async () => {
    const h = harness();
    await h.service.onModuleInit();
    const ready = (path: string, widths: number[]) => ({
      sourceUrl: `${CDN}/${path}.jpg`,
      status: MediaAssetStatus.READY,
      version: 'v1',
      widths,
      checkedAt: new Date(),
    });
    h.prisma.mediaAsset.findMany.mockResolvedValue([
      ready('covers/42', [225]),
      ready('backdrops/42', [640, 1280, 1900]),
      // Failed recently: the source URL stays and no job is queued yet.
      {
        sourceUrl: `${CDN}/screenshots/42/12.5.jpg`,
        status: MediaAssetStatus.FAILED,
        version: null,
        widths: [],
        checkedAt: new Date(),
      },
    ]);

    const body = await h.service.localize(response());

    const base = 'https://media.test/animehub-media';
    for (const { anime, episode } of body.data) {
      expect(anime).toMatchObject({
        posterUrl: `${base}/covers/42-v1-225.webp`,
        backdropUrl: `${base}/backdrops/42-v1-1900.webp`,
        backdropSrcSet: `${base}/backdrops/42-v1-640.webp 640w, ${base}/backdrops/42-v1-1280.webp 1280w, ${base}/backdrops/42-v1-1900.webp 1900w`,
      });
      expect(episode.imageUrl).toBe(`${CDN}/screenshots/42/12.5.jpg`);
    }
    expect(h.boss.insert).not.toHaveBeenCalled();
  });

  it('answers null for images the source does not have, rechecked daily', async () => {
    const h = harness();
    await h.service.onModuleInit();
    const missing = (path: string, hoursAgo: number) => ({
      sourceUrl: `${CDN}/${path}.jpg`,
      status: MediaAssetStatus.MISSING,
      version: null,
      widths: [],
      checkedAt: new Date(Date.now() - hoursAgo * 60 * 60_000),
    });
    h.prisma.mediaAsset.findMany.mockResolvedValue([
      missing('backdrops/42', 1),
      missing('screenshots/42/12.5', 25),
    ]);

    const body = await h.service.localize(response());

    for (const { anime, episode } of body.data) {
      expect(anime).toMatchObject({
        posterUrl: `${CDN}/covers/42.jpg`,
        backdropUrl: null,
        backdropSrcSet: null,
      });
      expect(episode.imageUrl).toBeNull();
    }
    // The cover has no row yet; the screenshot's absence is a day old.
    await vi.waitFor(() => expect(h.boss.insert).toHaveBeenCalledOnce());
    expect(
      (
        h.boss.insert.mock.calls[0] as [string, { singletonKey: string }[]]
      )[1].map((job) => job.singletonKey),
    ).toEqual([`${CDN}/covers/42.jpg`, `${CDN}/screenshots/42/12.5.jpg`]);
  });

  it('ignores URLs that are not source images', async () => {
    const h = harness();
    await h.service.onModuleInit();
    const body = {
      data: { posterUrl: 'https://example.com/covers/1.jpg', imageUrl: null },
    };

    await h.service.localize(body);

    expect(h.prisma.mediaAsset.findMany).not.toHaveBeenCalled();
  });
});

describe('MediaService.convert', () => {
  const lastUpsert = (h: ReturnType<typeof harness>) =>
    h.prisma.mediaAsset.upsert.mock.lastCall?.[0] as {
      create: object;
      update: object;
    };

  it('uploads every width with a year of immutable caching', async () => {
    const h = harness();
    const input = await fixture();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(input), {
        headers: { etag: '"abc"', 'content-type': 'image/jpeg' },
      }),
    );
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);

    await h.service.convert(`${CDN}/backdrops/42.jpg`);

    const uploads = send.mock.calls.map(
      ([command]) => (command as PutObjectCommand).input,
    );
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.Key).toMatch(
        /^backdrops\/42-[0-9a-f]{16}-(640|1200)\.webp$/,
      );
      expect(upload).toMatchObject({
        Bucket: 'animehub-media',
        ContentType: 'image/webp',
        CacheControl: MEDIA_CACHE_CONTROL,
      });
    }
    expect(lastUpsert(h).update).toMatchObject({
      status: MediaAssetStatus.READY,
      widths: [640, 1200],
      etag: '"abc"',
    });
  });

  it('records a missing image without retrying, and retries a source outage', async () => {
    const h = harness();
    const send = vi.spyOn(S3Client.prototype, 'send');
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(
      h.service.convert(`${CDN}/covers/42.jpg`),
    ).resolves.toBeUndefined();
    await expect(h.service.convert(`${CDN}/covers/42.jpg`)).rejects.toThrow(
      '503',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    const [missing, outage] = h.prisma.mediaAsset.upsert.mock.calls.map(
      ([args]) => args as { create: object; update: object },
    );
    expect(missing).toMatchObject({
      create: { status: MediaAssetStatus.MISSING, failures: 1 },
      update: { status: MediaAssetStatus.MISSING, failures: { increment: 1 } },
    });
    expect(outage).toMatchObject({
      create: { status: MediaAssetStatus.FAILED },
      update: { status: MediaAssetStatus.FAILED },
    });
  });

  it('keeps serving a ready copy the source no longer has', async () => {
    const h = harness();
    h.prisma.mediaAsset.findUnique.mockResolvedValue({
      sourceUrl: `${CDN}/covers/42.jpg`,
      status: MediaAssetStatus.READY,
      etag: '"abc"',
    });
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));

    await h.service.convert(`${CDN}/covers/42.jpg`);

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'if-none-match': '"abc"',
    });
    expect(lastUpsert(h).update).not.toHaveProperty('status');
  });

  it('refuses anything but a source image', async () => {
    const h = harness();
    const fetchMock = vi.spyOn(global, 'fetch');

    await h.service.convert('https://example.com/covers/42.jpg');
    await h.service.convert(`${CDN}/covers/../secret.jpg`);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
