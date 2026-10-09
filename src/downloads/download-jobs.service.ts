import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import pLimit from 'p-limit';
import { PgBoss } from 'pg-boss';
import {
  DownloadJobItemStatus,
  DownloadJobStatus,
  Prisma,
} from '../generated/prisma/client';
import { AnimeService } from '../anime/anime.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateDownloadJobDto,
  DownloadJobReceiptResponseDto,
  DownloadJobResponseDto,
  DownloadScopeDto,
  ProviderDto,
  RequestedAudioDto,
  ResolvedEpisodeDto,
} from './download.dto';
import { DownloadResolverService } from './download-resolver.service';

const QUEUE_NAME = 'animehub-download-job';

const ACTIVE_JOB_STATUSES: DownloadJobStatus[] = [
  DownloadJobStatus.QUEUED,
  DownloadJobStatus.RUNNING,
];
const RETRYABLE_JOB_STATUSES: DownloadJobStatus[] = [
  DownloadJobStatus.PARTIAL,
  DownloadJobStatus.FAILED,
];
const UNFINISHED_ITEM_STATUSES: DownloadJobItemStatus[] = [
  DownloadJobItemStatus.PENDING,
  DownloadJobItemStatus.RUNNING,
];

export function hashCapabilityToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class DownloadJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DownloadJobsService.name);
  private readonly episodeLimit = pLimit(8);
  private boss?: PgBoss;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly animeService: AnimeService,
    private readonly resolver: DownloadResolverService,
  ) {}

  async onModuleInit() {
    if (this.config.get<string>('JOBS_ENABLED', 'true') === 'false') return;
    const connectionString = this.config.getOrThrow<string>('DATABASE_URL');
    // Scope pg-boss to our own schema on the shared Postgres (from ?schema= in the
    // URL) so its tables don't collide with other projects' pg-boss. Absent
    // (local dev) → pg-boss default schema.
    const schemaMatch = /[?&]schema=([^&]+)/.exec(connectionString);
    this.boss = new PgBoss({
      connectionString,
      application_name: 'animehub-api',
      ...(schemaMatch ? { schema: decodeURIComponent(schemaMatch[1]) } : {}),
    });
    this.boss.on('error', (error) => this.logger.error(error.message));
    await this.boss.start();
    await this.boss.createQueue(QUEUE_NAME, {
      policy: 'standard',
      notify: true,
    });
    await this.boss.work<{ jobId: string }>(
      QUEUE_NAME,
      { localConcurrency: 2, groupConcurrency: 2, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await this.process(job.data.jobId);
      },
    );
  }

  async onModuleDestroy() {
    await this.boss?.stop({ graceful: true });
  }

  async create(
    slug: string,
    input: CreateDownloadJobDto,
  ): Promise<DownloadJobReceiptResponseDto> {
    const anime = await this.animeService.ensureAnime(slug);
    const { episodes, missingEpisodeNumbers } = await this.selectEpisodes(
      anime.id,
      input,
    );
    if (episodes.length === 0) {
      throw new BadRequestException('No episodes match the requested scope.');
    }
    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    const job = await this.prisma.downloadJob.create({
      data: {
        animeId: anime.id,
        accessTokenHash: hashCapabilityToken(accessToken),
        requestedAudio: input.audio,
        providers: input.providers,
        packageName: anime.title,
        totalItems: episodes.length,
        expiresAt,
        items: {
          create: episodes.map((episode) => ({ episodeId: episode.id })),
        },
      },
    });
    if (this.boss) {
      await this.boss.send(
        QUEUE_NAME,
        { jobId: job.id },
        { group: { id: 'bulk' } },
      );
    } else {
      void this.process(job.id);
    }
    return {
      data: {
        jobId: job.id,
        accessToken,
        expiresAt: expiresAt.toISOString(),
        missingEpisodeNumbers,
      },
    };
  }

  private async selectEpisodes(animeId: string, input: CreateDownloadJobDto) {
    if (input.scope === DownloadScopeDto.EPISODES) {
      // Validation guarantees a non-empty, duplicate-free list; -0 → 0.
      const requested = [
        ...new Set((input.episodeNumbers ?? []).map((value) => value + 0)),
      ].sort((a, b) => a - b);
      const episodes = await this.prisma.episode.findMany({
        where: { animeId, number: { in: requested } },
        orderBy: { number: 'asc' },
        select: { id: true, number: true },
      });
      const found = new Set(episodes.map((episode) => episode.number));
      return {
        episodes,
        missingEpisodeNumbers: requested.filter((value) => !found.has(value)),
      };
    }
    // RANGE always carries both bounds (validated, from <= to); ALL ignores
    // any bounds older clients still send.
    const episodes = await this.prisma.episode.findMany({
      where:
        input.scope === DownloadScopeDto.RANGE
          ? { animeId, number: { gte: input.from, lte: input.to } }
          : { animeId },
      orderBy: { number: 'asc' },
      select: { id: true, number: true },
    });
    return { episodes, missingEpisodeNumbers: [] as number[] };
  }

  async get(jobId: string, token: string): Promise<DownloadJobResponseDto> {
    const job = await this.authorize(jobId, token);
    return { data: this.serialize(job) };
  }

  /**
   * Cancels a job that is still QUEUED or RUNNING: the job and its unfinished
   * items become CANCELLED in one transaction. A job that already finished
   * (COMPLETED, PARTIAL or FAILED) is left untouched and returned as is, so the
   * caller can tell from `status` that the cancellation came too late.
   */
  async cancel(jobId: string, token: string): Promise<DownloadJobResponseDto> {
    await this.authorize(jobId, token);
    await this.prisma.$transaction(async (transaction) => {
      const cancelled = await transaction.downloadJob.updateMany({
        where: { id: jobId, status: { in: ACTIVE_JOB_STATUSES } },
        data: { status: DownloadJobStatus.CANCELLED, completedAt: new Date() },
      });
      if (cancelled.count === 0) return;
      // Items being resolved right now are cancelled too: process() only
      // records a result over a RUNNING item, so the job stays as cancelled.
      await transaction.downloadJobItem.updateMany({
        where: { jobId, status: { in: UNFINISHED_ITEM_STATUSES } },
        data: { status: DownloadJobItemStatus.CANCELLED },
      });
    });
    return this.get(jobId, token);
  }

  /**
   * Re-queues the failed items of a finished PARTIAL or FAILED job. A job that
   * is still active, was cancelled or has no failures cannot be retried.
   */
  async retry(jobId: string, token: string): Promise<DownloadJobResponseDto> {
    await this.authorize(jobId, token);
    await this.prisma.$transaction(async (transaction) => {
      const requeued = await transaction.downloadJob.updateMany({
        where: { id: jobId, status: { in: RETRYABLE_JOB_STATUSES } },
        data: {
          status: DownloadJobStatus.QUEUED,
          failedItems: 0,
          completedAt: null,
        },
      });
      if (requeued.count === 0) {
        throw new BadRequestException(
          'Only a finished job with failed episodes can be retried.',
        );
      }
      const reset = await transaction.downloadJobItem.updateMany({
        where: { jobId, status: DownloadJobItemStatus.FAILED },
        data: {
          status: DownloadJobItemStatus.PENDING,
          errorCode: null,
          links: Prisma.JsonNull,
        },
      });
      // Throwing rolls the job update back as well.
      if (reset.count === 0)
        throw new BadRequestException('The job has no failed episodes.');
    });
    if (this.boss) {
      await this.boss.send(QUEUE_NAME, { jobId }, { group: { id: 'bulk' } });
    } else void this.process(jobId);
    return this.get(jobId, token);
  }

  // Every write below is guarded on the state it expects, so a concurrent
  // cancel() always wins: process() never revives a CANCELLED job or item.
  private async process(jobId: string) {
    const job = await this.prisma.downloadJob.findUnique({
      where: { id: jobId },
      include: { anime: true, items: { include: { episode: true } } },
    });
    if (
      !job ||
      job.status === DownloadJobStatus.CANCELLED ||
      job.expiresAt <= new Date()
    ) {
      return;
    }
    const started = await this.prisma.downloadJob.updateMany({
      where: { id: jobId, status: { in: ACTIVE_JOB_STATUSES } },
      data: {
        status: DownloadJobStatus.RUNNING,
        startedAt: job.startedAt ?? new Date(),
      },
    });
    if (started.count === 0) return;
    const pending = job.items.filter(
      (item) => item.status === DownloadJobItemStatus.PENDING,
    );
    for (let offset = 0; offset < pending.length; offset += 50) {
      const block = pending.slice(offset, offset + 50);
      await Promise.all(
        block.map((item) =>
          this.episodeLimit(async () => {
            // cancel() turns PENDING items into CANCELLED in the same
            // transaction as the job, so a cancelled item is never claimed.
            const claimed = await this.prisma.downloadJobItem.updateMany({
              where: { id: item.id, status: DownloadJobItemStatus.PENDING },
              data: {
                status: DownloadJobItemStatus.RUNNING,
                attempts: { increment: 1 },
              },
            });
            if (claimed.count === 0) return;
            let result: Prisma.DownloadJobItemUpdateManyMutationInput;
            try {
              const resolved = await this.resolver.resolveEpisode(
                job.animeId,
                job.anime.slug,
                item.episode.number,
                job.requestedAudio as RequestedAudioDto,
                job.providers as ProviderDto[],
              );
              result = {
                status: resolved.errorCode
                  ? DownloadJobItemStatus.FAILED
                  : DownloadJobItemStatus.COMPLETED,
                resolvedAudio: resolved.audio,
                links: resolved.links as unknown as Prisma.InputJsonValue,
                errorCode: resolved.errorCode,
              };
            } catch {
              result = {
                status: DownloadJobItemStatus.FAILED,
                errorCode: 'SOURCE_UNAVAILABLE',
              };
            }
            // A cancel() during the resolution already moved the item on.
            await this.prisma.downloadJobItem.updateMany({
              where: { id: item.id, status: DownloadJobItemStatus.RUNNING },
              data: result,
            });
          }),
        ),
      );
    }
    const [completedItems, failedItems, cancelledItems] = await Promise.all([
      this.prisma.downloadJobItem.count({
        where: { jobId, status: DownloadJobItemStatus.COMPLETED },
      }),
      this.prisma.downloadJobItem.count({
        where: { jobId, status: DownloadJobItemStatus.FAILED },
      }),
      this.prisma.downloadJobItem.count({
        where: { jobId, status: DownloadJobItemStatus.CANCELLED },
      }),
    ]);
    const status =
      cancelledItems === job.totalItems
        ? DownloadJobStatus.CANCELLED
        : completedItems === job.totalItems
          ? DownloadJobStatus.COMPLETED
          : completedItems > 0
            ? DownloadJobStatus.PARTIAL
            : DownloadJobStatus.FAILED;
    const finished = await this.prisma.downloadJob.updateMany({
      where: { id: jobId, status: DownloadJobStatus.RUNNING },
      data: { status, completedItems, failedItems, completedAt: new Date() },
    });
    if (finished.count === 0) {
      // Cancelled meanwhile: keep CANCELLED and its completedAt, but record
      // the items that were resolved before the cancellation.
      await this.prisma.downloadJob.updateMany({
        where: { id: jobId, status: DownloadJobStatus.CANCELLED },
        data: { completedItems, failedItems },
      });
    }
  }

  private async authorize(jobId: string, token: string) {
    const job = await this.prisma.downloadJob.findUnique({
      where: { id: jobId },
      include: {
        items: {
          orderBy: { episode: { number: 'asc' } },
          include: { episode: true },
        },
      },
    });
    if (
      !job ||
      job.expiresAt <= new Date() ||
      hashCapabilityToken(token) !== job.accessTokenHash
    ) {
      throw new UnauthorizedException('Invalid or expired job capability.');
    }
    return job;
  }

  private serialize(
    job: Awaited<ReturnType<DownloadJobsService['authorize']>>,
  ) {
    const completedItems = job.items.filter(
      (item) => item.status === DownloadJobItemStatus.COMPLETED,
    ).length;
    const failedItems = job.items.filter(
      (item) => item.status === DownloadJobItemStatus.FAILED,
    ).length;
    return {
      id: job.id,
      status: job.status,
      packageName: job.packageName,
      totalItems: job.totalItems,
      // Item state is the live source of truth while a bulk job is running.
      // The aggregate columns are finalized only when the worker completes.
      completedItems,
      failedItems,
      expiresAt: job.expiresAt.toISOString(),
      episodes: job.items
        .filter(
          (item) =>
            item.status === DownloadJobItemStatus.COMPLETED ||
            item.status === DownloadJobItemStatus.FAILED ||
            item.status === DownloadJobItemStatus.CANCELLED,
        )
        .map((item): ResolvedEpisodeDto => ({
          episodeNumber: item.episode.number,
          audio: (item.resolvedAudio ??
            job.requestedAudio) as RequestedAudioDto,
          links: Array.isArray(item.links)
            ? (item.links as Array<{ provider: ProviderDto; url: string }>)
            : [],
          errorCode: item.errorCode,
        })),
    };
  }
}
