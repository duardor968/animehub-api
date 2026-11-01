import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SnapshotKind } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { bySlug, ProjectionService } from '../projection/projection.service';
import { isCatalogCapped } from '../source/animeav1.constants';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
} from '../source/animeav1.service';
import { CATALOG_PASS_KEY, isDegenerateCatalogPage } from './catalog.service';

const LEASE_KEY = 'catalog-pass';
/** A pass takes about 8 minutes (245 pages in 2026); this is its deadline. */
const LEASE_MS = 30 * 60_000;
const PASS_INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const CHECK_INTERVAL_MS = 10 * 60_000;
/** Pause after every source request: one at a time, never back to back. */
export const SOURCE_GAP_MS = 1_000;

/**
 * The year ranges that together list the whole source catalog, each under
 * its 1000-record cap. Its year filter starts at 1990: the older anime fit
 * in one range (134 in October 2026).
 */
export function yearRanges(lastYear: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [[1900, 1989]];
  for (let year = 1990; year <= lastYear; year++) ranges.push([year, year]);
  return ranges;
}

/**
 * Once a day, walks the source catalog year by year, stores every listed
 * anime (new ones get their detail from DetailRefreshScheduler) and, only
 * when it saw the whole catalog, asks the source about the stored anime it
 * no longer lists. A lease keeps it to one process.
 */
@Injectable()
export class CatalogPassScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogPassScheduler.name);
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private active?: Promise<void>;
  private stopped = false;

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

  /** Runs the pass when it is due and no other process holds it. */
  runDue() {
    this.active = this.leased().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async leased() {
    const token = await this.acquire();
    if (!token) return;
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), LEASE_MS);
    let complete = false;
    try {
      complete = await this.pass(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        this.logger.warn(`Catalog pass failed: ${String(error)}`);
    } finally {
      clearTimeout(deadline);
      this.controller = undefined;
      await this.release(token, complete);
    }
  }

  private async pass(signal: AbortSignal) {
    const started = Date.now();
    const seen = new Set<string>();
    let requests = 0;
    let complete = true;
    let taxonomyStored = false;
    const ranges = yearRanges(new Date().getUTCFullYear() + 1);
    for (const [minYear, maxYear] of ranges) {
      for (let page = 1, pages = 1; page <= pages; page++) {
        // Newest first: an anime added meanwhile pushes the rest down a
        // place, which repeats one on the next page instead of skipping one.
        const params = new URLSearchParams({
          maxYear: String(maxYear),
          minYear: String(minYear),
          order: 'latest_added',
          page: String(page),
        });
        requests++;
        const result = await this.source
          .getCatalog(params, signal)
          .catch((error: unknown) => {
            signal.throwIfAborted();
            this.logger.warn(
              `Catalog pass page ${minYear}-${maxYear}/${page} failed: ${String(error)}`,
            );
            return null;
          });
        await sleep(SOURCE_GAP_MS, undefined, { signal });
        if (
          !result ||
          isDegenerateCatalogPage(
            result.results.length,
            result.totalRecords,
            result.totalPages,
            page,
          ) ||
          // A capped range lists only part of its anime.
          isCatalogCapped(result.totalRecords)
        ) {
          complete = false;
          break;
        }
        pages = result.totalPages;
        if (!taxonomyStored) {
          for (const category of result.categories)
            await this.prisma.category.upsert(bySlug(category));
          for (const genre of result.genres)
            await this.prisma.genre.upsert(bySlug(genre));
          taxonomyStored = true;
        }
        for (const entry of result.results) {
          await this.projection.upsertAnime(entry);
          seen.add(entry.id);
        }
      }
    }
    let unlisted = 0;
    if (complete) {
      // Stored anime the whole listing no longer shows: the source decides
      // (two not-found answers make one unavailable).
      const missing = await this.prisma.anime.findMany({
        where: { availability: 'AVAILABLE', sourceId: { notIn: [...seen] } },
        select: { slug: true },
      });
      unlisted = missing.length;
      for (const { slug } of missing) {
        requests++;
        try {
          await this.projection.upsertDetail(
            await this.source.getAnime(slug, signal),
          );
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof AnimeAv1NotFoundError)
            await this.projection.markNotFound(slug);
          else
            this.logger.warn(
              `Catalog pass check of ${slug} failed: ${String(error)}`,
            );
        }
        await sleep(SOURCE_GAP_MS, undefined, { signal });
      }
      await this.projection.replaceSnapshot(
        CATALOG_PASS_KEY,
        SnapshotKind.CATALOG,
        [],
        { ttlMinutes: PASS_INTERVAL_MS / 60_000, totalRecords: seen.size },
      );
    }
    this.logger.log({
      event: 'catalog.pass',
      complete,
      listed: seen.size,
      unlisted,
      requests,
      durationMs: Date.now() - started,
    });
    return complete;
  }

  private async acquire() {
    const now = new Date();
    await this.prisma.homeRefreshLease.createMany({
      data: [{ key: LEASE_KEY, expiresAt: now, nextAttemptAt: now }],
      skipDuplicates: true,
    });
    const token = randomUUID();
    const { count } = await this.prisma.homeRefreshLease.updateMany({
      where: {
        key: LEASE_KEY,
        expiresAt: { lte: now },
        nextAttemptAt: { lte: now },
      },
      data: { token, expiresAt: new Date(now.getTime() + LEASE_MS) },
    });
    return count ? token : null;
  }

  private async release(token: string, complete: boolean) {
    const now = new Date();
    await this.prisma.homeRefreshLease.updateMany({
      where: { key: LEASE_KEY, token },
      data: {
        token: null,
        expiresAt: now,
        nextAttemptAt: new Date(
          now.getTime() + (complete ? PASS_INTERVAL_MS : RETRY_MS),
        ),
      },
    });
  }

  private async run() {
    try {
      await this.runDue();
    } catch (error) {
      this.logger.warn(`Catalog pass unavailable: ${String(error)}`);
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run();
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }
}
