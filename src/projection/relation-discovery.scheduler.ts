import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { ProjectionService } from './projection.service';

const INTERVAL_MS = 5 * 60_000;
const BUDGET_MS = 30_000;
const BATCH_SIZE = 8;

/** Discover edges from newly observed titles, including edges towards finished titles. */
@Injectable()
export class RelationDiscoveryScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RelationDiscoveryScheduler.name);
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private active?: Promise<void>;
  private stopped = false;
  private readonly retries = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly source: AnimeAv1Service,
    private readonly projection: ProjectionService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('JOBS_ENABLED', 'true') !== 'false')
      void this.run();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    await this.active;
  }

  refreshObserved() {
    this.active = this.refresh().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async refresh() {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), BUDGET_MS);
    try {
      const now = new Date();
      for (const [slug, retryAt] of this.retries) {
        if (retryAt <= now.getTime()) this.retries.delete(slug);
      }
      const candidates = await this.prisma.anime.findMany({
        where: {
          slug: { notIn: [...this.retries.keys()] },
          availability: 'AVAILABLE',
          snapshotItems: {
            some: {
              snapshot: {
                fetchedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
              },
            },
          },
          OR: [
            { detailFetchedAt: null },
            { detailFetchedAt: { lte: new Date(now.getTime() - 86_400_000) } },
            { nextRefreshAt: { lte: now } },
          ],
        },
        orderBy: [
          { detailFetchedAt: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
        take: BATCH_SIZE,
        select: { slug: true },
      });
      // Serial requests and a shared deadline cap source work for each pass.
      for (const candidate of candidates) {
        if (controller.signal.aborted) break;
        try {
          const detail = await this.source.getAnime(
            candidate.slug,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          await this.projection.upsertDetail(detail);
        } catch (error) {
          this.retries.set(candidate.slug, Date.now() + 30 * 60_000);
          if (controller.signal.aborted) break;
          this.logger.warn(
            `Relation discovery failed for ${candidate.slug}: ${String(error)}`,
          );
        }
      }
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
    }
  }

  private async run() {
    try {
      await this.refreshObserved();
    } catch (error) {
      this.logger.warn(`Relation discovery unavailable: ${String(error)}`);
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run();
    }, INTERVAL_MS);
    this.timer.unref?.();
  }
}
