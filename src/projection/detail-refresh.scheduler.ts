import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../prisma/prisma.service';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
} from '../source/animeav1.service';
import { ProjectionService } from './projection.service';

const INTERVAL_MS = 5 * 60_000;
const BUDGET_MS = 2 * 60_000;
const BATCH_SIZE = 20;
/** Pause after every source request: one at a time, never back to back. */
const SOURCE_GAP_MS = 1_000;
const DAY_MS = 86_400_000;

/**
 * Keeps the detail (status, genres, dates, score, votes, episodes and
 * relations) of every available anime: the never fetched first, then those
 * due at their status's cadence. Airing series are renewed once a day here;
 * their pages, the schedule and the home renew them sooner while watched.
 */
@Injectable()
export class DetailRefreshScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DetailRefreshScheduler.name);
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

  refreshDue() {
    this.active = this.refresh().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async refresh() {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const timeout = setTimeout(() => controller.abort(), BUDGET_MS);
    try {
      for (;;) {
        const now = new Date();
        for (const [slug, retryAt] of this.retries) {
          if (retryAt <= now.getTime()) this.retries.delete(slug);
        }
        const candidates = await this.prisma.anime.findMany({
          where: {
            slug: { notIn: [...this.retries.keys()] },
            availability: 'AVAILABLE',
            OR: [
              { detailFetchedAt: null },
              { status: { not: 'AIRING' }, nextRefreshAt: { lte: now } },
              {
                status: 'AIRING',
                detailFetchedAt: { lte: new Date(now.getTime() - DAY_MS) },
              },
            ],
          },
          orderBy: [
            { detailFetchedAt: { sort: 'asc', nulls: 'first' } },
            { id: 'asc' },
          ],
          take: BATCH_SIZE,
          select: { slug: true },
        });
        if (candidates.length === 0) return;
        for (const { slug } of candidates) {
          try {
            const detail = await this.source.getAnime(slug, signal);
            signal.throwIfAborted();
            await this.projection.upsertDetail(detail);
          } catch (error) {
            if (signal.aborted) return;
            this.retries.set(slug, Date.now() + 30 * 60_000);
            if (error instanceof AnimeAv1NotFoundError)
              await this.projection.markNotFound(slug);
            else
              this.logger.warn(
                `Detail refresh failed for ${slug}: ${String(error)}`,
              );
          }
          await sleep(SOURCE_GAP_MS, undefined, { signal }).catch(
            () => undefined,
          );
          if (signal.aborted) return;
        }
      }
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
    }
  }

  private async run() {
    try {
      await this.refreshDue();
    } catch (error) {
      this.logger.warn(`Detail refresh unavailable: ${String(error)}`);
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run();
    }, INTERVAL_MS);
    this.timer.unref?.();
  }
}
