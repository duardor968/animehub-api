import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import sharp from 'sharp';
import type { MediaAsset } from '../generated/prisma/client';
import { MediaAssetStatus } from '../generated/prisma/enums';
import { JobQueue } from '../jobs/job-queue';
import { PrismaService } from '../prisma/prisma.service';
import { ANIMEAV1_CDN_URL } from '../source/animeav1.constants';

const QUEUE_NAME = 'animehub-media';
// Response fields that carry a source image; backdropUrl gets a srcset too.
const IMAGE_FIELDS = ['posterUrl', 'backdropUrl', 'imageUrl'] as const;
// The source images this API links to, and nothing else.
const SOURCE_IMAGE = new RegExp(
  `^${ANIMEAV1_CDN_URL.replaceAll('.', '\\.')}/(covers|backdrops|screenshots)/\\d+(?:/\\d+(?:\\.\\d+)?)?\\.jpg$`,
);
// Stored widths per kind; null keeps the source width. Never upscaled.
const WIDTHS: Record<string, readonly (number | null)[]> = {
  covers: [null],
  screenshots: [null],
  backdrops: [640, 1280, 1900],
};
const WEBP_QUALITY = 75;
// The largest source image, a 1900×400 backdrop, is about 360 KB.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 4096 * 4096;
const FETCH_TIMEOUT_MS = 15_000;
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60_000;
// As long as the source itself lets its images be cached.
const REVALIDATE_AFTER_MS = 365 * 24 * 60 * 60_000;
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const SETTINGS = [
  'MEDIA_S3_ENDPOINT',
  'MEDIA_S3_REGION',
  'MEDIA_S3_ACCESS_KEY_ID',
  'MEDIA_S3_SECRET_ACCESS_KEY',
  'MEDIA_S3_BUCKET',
  'MEDIA_PUBLIC_URL',
] as const;

/** A failure that retrying cannot fix: no such image, or not a usable one. */
class UnusableSourceError extends Error {}
/** The source has no such image. */
class MissingSourceError extends UnusableSourceError {}

function isSourceImage(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_IMAGE.test(value);
}

/** One WebP per distinct width, ascending; the source width caps them all. */
export async function toWebp(
  input: Buffer,
  widths: readonly (number | null)[],
) {
  const image = sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS });
  const { width } = await image.metadata();
  const targets = new Set(
    widths
      .map((target) => Math.min(target ?? width, width))
      .sort((a, b) => a - b),
  );
  return Promise.all(
    [...targets].map(async (target) => ({
      width: target,
      body: await image
        .clone()
        .resize({ width: target })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer(),
    })),
  );
}

function* imageOwners(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* imageOwners(item);
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    if (IMAGE_FIELDS.some((field) => isSourceImage(record[field]))) {
      yield record;
    }
    for (const child of Object.values(record)) yield* imageOwners(child);
  }
}

function isDue(asset: MediaAsset | undefined, now: number) {
  if (!asset) return true;
  const age = now - asset.checkedAt.getTime();
  return asset.status === MediaAssetStatus.READY
    ? age > REVALIDATE_AFTER_MS
    : age > RETRY_FAILED_AFTER_MS;
}

/**
 * Serves source images from our bucket as WebP. A response keeps the source
 * URL of an image until its copy is ready, and queues the conversion.
 */
@Injectable()
export class MediaService implements OnModuleInit {
  private readonly logger = new Logger(MediaService.name);
  private readonly storage: {
    s3: S3Client;
    bucket: string;
    publicUrl: string;
  } | null = null;
  private readonly userAgent: string;
  private boss: PgBoss | null = null;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
  ) {
    this.userAgent = config.getOrThrow<string>('SOURCE_USER_AGENT');
    const values = SETTINGS.map((key) => config.get<string>(key) || '');
    if (!values.every(Boolean)) {
      if (values.some(Boolean)) {
        this.logger.warn(
          `Media storage needs all of ${SETTINGS.join(', ')}; serving source image URLs.`,
        );
      }
      return;
    }
    const [endpoint, region, accessKeyId, secretAccessKey, bucket, publicUrl] =
      values;
    this.storage = {
      s3: new S3Client({
        endpoint,
        region,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
        // S3-compatible stores (Supabase, MinIO) may reject the checksums the
        // SDK adds by default; send them only where the API requires them.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
      bucket,
      publicUrl: publicUrl.replace(/\/$/, ''),
    };
  }

  async onModuleInit() {
    if (!this.storage) return;
    // exclusive: one queued or active conversion per image (singletonKey).
    this.boss = await this.queue.open(QUEUE_NAME, 'exclusive', {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });
    // Two downloads at a time per instance, to spare the source CDN.
    await this.boss?.work<{ url: string }>(
      QUEUE_NAME,
      { localConcurrency: 2, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) await this.convert(job.data.url);
      },
    );
  }

  /**
   * Points the source image fields of a response at their WebP copies, in
   * place, with one lookup for the whole response. An image the source does
   * not have becomes null; any other without a ready copy keeps its source
   * URL. Both are queued for conversion when due.
   */
  async localize<T>(body: T): Promise<T> {
    if (!this.storage) return body;
    const owners = [...imageOwners(body)];
    const urls = [
      ...new Set(
        owners.flatMap((owner) =>
          IMAGE_FIELDS.map((field) => owner[field]).filter(isSourceImage),
        ),
      ),
    ];
    if (!urls.length) return body;
    let assets: Map<string, MediaAsset>;
    try {
      const rows = await this.prisma.mediaAsset.findMany({
        where: { sourceUrl: { in: urls } },
      });
      assets = new Map(rows.map((row) => [row.sourceUrl, row]));
    } catch (error) {
      this.logger.warn(`Image lookup failed: ${String(error)}`);
      return body;
    }
    for (const owner of owners) {
      for (const field of IMAGE_FIELDS) {
        const asset = assets.get(owner[field] as string);
        if (asset?.status === MediaAssetStatus.MISSING) owner[field] = null;
        if (asset?.status !== MediaAssetStatus.READY) continue;
        owner[field] = this.url(asset, asset.widths.at(-1)!);
        if (field === 'backdropUrl') {
          owner.backdropSrcSet = asset.widths
            .map((width) => `${this.url(asset, width)} ${width}w`)
            .join(', ');
        }
      }
    }
    const now = Date.now();
    const due = urls.filter((url) => isDue(assets.get(url), now));
    if (due.length) void this.enqueue(due);
    return body;
  }

  /** Downloads one source image, stores its WebP widths and records it. */
  async convert(sourceUrl: string) {
    const kind = SOURCE_IMAGE.exec(sourceUrl)?.[1];
    if (!this.storage || !kind) return;
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { sourceUrl },
    });
    const checkedAt = new Date();
    try {
      const response = await fetch(sourceUrl, {
        headers: {
          'user-agent': this.userAgent,
          ...(asset?.status === MediaAssetStatus.READY && asset.etag
            ? { 'if-none-match': asset.etag }
            : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 304) {
        await this.prisma.mediaAsset.update({
          where: { sourceUrl },
          data: { checkedAt },
        });
        return;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const message = `Source answered ${response.status}`;
        throw [403, 404, 410].includes(response.status)
          ? new MissingSourceError(message)
          : new Error(message);
      }
      const input = await readBody(response, MAX_SOURCE_BYTES);
      const version = createHash('sha256')
        .update(input)
        .digest('hex')
        .slice(0, 16);
      const etag = response.headers.get('etag');
      if (asset?.version === version) {
        await this.prisma.mediaAsset.update({
          where: { sourceUrl },
          data: { etag, checkedAt },
        });
        return;
      }
      const variants = await toWebp(input, WIDTHS[kind]).catch(
        (error: unknown) => {
          throw new UnusableSourceError(String(error));
        },
      );
      const { s3, bucket } = this.storage;
      await Promise.all(
        variants.map(({ width, body }) =>
          s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: objectKey(sourceUrl, version, width),
              Body: body,
              ContentType: 'image/webp',
              CacheControl: MEDIA_CACHE_CONTROL,
            }),
          ),
        ),
      );
      const data = {
        status: MediaAssetStatus.READY,
        version,
        widths: variants.map(({ width }) => width),
        etag,
        bytes: variants.reduce((total, { body }) => total + body.length, 0),
        checkedAt,
      };
      await this.prisma.mediaAsset.upsert({
        where: { sourceUrl },
        create: { sourceUrl, ...data },
        update: data,
      });
    } catch (error) {
      const status =
        error instanceof MissingSourceError
          ? MediaAssetStatus.MISSING
          : MediaAssetStatus.FAILED;
      // A ready copy stays in use; the failure only postpones the next check.
      await this.prisma.mediaAsset.upsert({
        where: { sourceUrl },
        create: { sourceUrl, status, failures: 1 },
        update: {
          failures: { increment: 1 },
          checkedAt,
          ...(asset?.status === MediaAssetStatus.READY ? {} : { status }),
        },
      });
      this.logger.warn(`Image ${sourceUrl} not converted: ${String(error)}`);
      // Anything else is transient: pg-boss retries it with backoff.
      if (!(error instanceof UnusableSourceError)) throw error;
    }
  }

  private url(asset: MediaAsset, width: number) {
    return `${this.storage!.publicUrl}/${objectKey(asset.sourceUrl, asset.version!, width)}`;
  }

  // One job per image; the exclusive policy drops those already queued.
  private async enqueue(urls: string[]) {
    try {
      await this.boss?.insert(
        QUEUE_NAME,
        urls.map((url) => ({ data: { url }, singletonKey: url })),
      );
    } catch (error) {
      this.logger.warn(`Image conversions not queued: ${String(error)}`);
    }
  }
}

/** covers/197.jpg → covers/197-<version>-<width>.webp */
function objectKey(sourceUrl: string, version: string, width: number) {
  const path = sourceUrl.slice(ANIMEAV1_CDN_URL.length + 1, -'.jpg'.length);
  return `${path}-${version}-${width}.webp`;
}

async function readBody(response: Response, limit: number) {
  const tooLarge = () =>
    new UnusableSourceError(`Source image exceeds ${limit} bytes`);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
