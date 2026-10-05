import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SnapshotKind } from '../generated/prisma/enums';
import { HomeResponseDto } from '../common/contracts';
import {
  serializeAnime,
  serializeEpisode,
  serializeFeatured,
} from '../common/serializers';
import type { SourceHome } from '../source/source.types';
import { AnimeAv1Service } from '../source/animeav1.service';
import {
  HomeStore,
  HOME_SNAPSHOT_KINDS,
  type HomeSnapshots,
  type HomeLease,
} from './home-store';
import {
  HOME_REFRESH_TIMEOUT_MS,
  HOME_RETRY_INTERVAL_MS,
  homeBackoffMs,
  type HomeRefreshMode,
} from './home-policy';

@Injectable()
export class HomeService implements OnModuleDestroy {
  private readonly logger = new Logger(HomeService.name);
  private refreshPromise?: Promise<void>;
  private readPromise?: Promise<HomeSnapshots>;
  private refreshController?: AbortController;
  private lastGood?: HomeResponseDto;
  private failures = 0;
  private retryAt = 0;

  constructor(
    private readonly store: HomeStore,
    private readonly source: AnimeAv1Service,
  ) {}

  onModuleDestroy() {
    this.refreshController?.abort();
  }

  async getHome(requestId: string = randomUUID()): Promise<HomeResponseDto> {
    const started = performance.now();
    let outcome = 'unavailable';
    try {
      let snapshots: HomeSnapshots;
      try {
        snapshots = await this.loadSnapshots();
      } catch {
        if (this.lastGood) {
          outcome = 'memory-stale';
          return {
            ...this.lastGood,
            meta: { ...this.lastGood.meta, stale: true },
          };
        }
        throw new ServiceUnavailableException('Home data is unavailable.');
      }
      const mode = this.dueMode(snapshots);
      // Never await the source, including cold or partial caches. The scheduled
      // worker also calls this coordinator, independently of page visits.
      if (mode) void this.refreshIfDue(requestId);
      const usable = snapshots.filter((snapshot) => snapshot.items.length > 0);
      if (!usable.length)
        throw new ServiceUnavailableException('Home data is unavailable.');
      const byKind = new Map(
        usable.map((snapshot) => [snapshot.kind, snapshot]),
      );
      const fetchedAt = new Date(
        Math.min(...usable.map((snapshot) => snapshot.fetchedAt.getTime())),
      );
      const nextRefreshAt = new Date(
        Math.min(...usable.map((snapshot) => snapshot.nextRefreshAt.getTime())),
      );
      const response: HomeResponseDto = {
        data: {
          featured: (byKind.get(SnapshotKind.HOME_FEATURED)?.items ?? []).map(
            ({ anime }) => serializeFeatured(anime),
          ),
          recentEpisodes: (
            byKind.get(SnapshotKind.HOME_RECENT_EPISODES)?.items ?? []
          ).flatMap(({ anime, episode }) =>
            episode
              ? [
                  {
                    anime: serializeAnime(anime),
                    episode: serializeEpisode(episode),
                  },
                ]
              : [],
          ),
          recentAnime: (
            byKind.get(SnapshotKind.HOME_RECENT_ANIME)?.items ?? []
          ).map(({ anime }) => serializeAnime(anime)),
        },
        meta: {
          fetchedAt: fetchedAt.toISOString(),
          nextRefreshAt: nextRefreshAt.toISOString(),
          stale:
            usable.length !== HOME_SNAPSHOT_KINDS.length ||
            nextRefreshAt.getTime() <= Date.now(),
        },
      };
      this.lastGood = response;
      outcome = response.meta.stale ? 'stale' : 'fresh';
      return response;
    } finally {
      this.logger.log({
        event: 'home.read',
        requestId,
        outcome,
        durationMs: Math.round(performance.now() - started),
      });
    }
  }

  // One local flight and one PostgreSQL lease cover EVERY mode and trigger.
  // Catch here, rather than at individual call sites: detached jobs cannot leak
  // rejections. Database outages also back off before another acquisition.
  refreshIfDue(triggerRequestId?: string): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (Date.now() < this.retryAt) return Promise.resolve();
    this.refreshPromise = this.runRefresh(triggerRequestId)
      .catch(() => {
        this.failures++;
        this.retryAt = Date.now() + homeBackoffMs(this.failures);
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }

  async nextRefreshDelay(): Promise<number> {
    const snapshots = await this.loadSnapshots();
    if (
      snapshots.length !== HOME_SNAPSHOT_KINDS.length ||
      snapshots.some((snapshot) => !snapshot.items.length)
    )
      return HOME_RETRY_INTERVAL_MS;
    const remaining =
      Math.min(
        ...snapshots.map((snapshot) => snapshot.nextRefreshAt.getTime()),
      ) - Date.now();
    return remaining > 0
      ? remaining
      : Math.max(HOME_RETRY_INTERVAL_MS, this.retryAt - Date.now());
  }

  private async runRefresh(triggerRequestId?: string) {
    const refreshId = randomUUID();
    const started = performance.now();
    const deadline = Date.now() + HOME_REFRESH_TIMEOUT_MS;
    const controller = new AbortController();
    this.refreshController = controller;
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Home refresh deadline', 'TimeoutError'),
        ),
      HOME_REFRESH_TIMEOUT_MS,
    );
    timer.unref?.();
    let lease: HomeLease | null = null;
    let outcome = 'failed';
    let mode: HomeRefreshMode | undefined;
    try {
      lease = await this.store.acquire();
      controller.signal.throwIfAborted();
      if (!lease) {
        outcome = 'leased-or-backoff';
        return;
      }
      const snapshots = await this.loadSnapshots();
      controller.signal.throwIfAborted();
      mode = this.dueMode(snapshots);
      if (!mode) {
        await this.store.release(lease, false);
        outcome = 'fresh';
        return;
      }
      const home = await this.source.getHome(controller.signal);
      controller.signal.throwIfAborted();
      const result = await this.store.publish(
        home,
        mode,
        lease,
        controller.signal,
        deadline,
        false,
      );
      // Core data is already visible. Optional display metadata never delays
      // cache publication and shares the same abort budget + fenced lease.
      if (mode === 'full')
        await this.enrich(home, lease, controller.signal, deadline);
      if (!controller.signal.aborted)
        await this.store.release(
          lease,
          result.partial,
          Math.max(1, deadline - Date.now()),
        );
      outcome = result.partial ? 'partial' : 'published';
      this.failures = 0;
      this.retryAt = 0;
    } catch {
      outcome = controller.signal.aborted ? 'aborted' : 'failed';
      if (lease && Date.now() < deadline) {
        // Release is bounded too. A dead process simply loses its 30s lease.
        await this.store
          .release(lease, true, deadline - Date.now())
          .catch(() => undefined);
      }
      throw new Error('Home refresh failed');
    } finally {
      clearTimeout(timer);
      if (this.refreshController === controller)
        this.refreshController = undefined;
      this.logger.log({
        event: 'home.refresh',
        refreshId,
        triggerRequestId,
        mode,
        outcome,
        durationMs: Math.round(performance.now() - started),
      });
    }
  }

  private async enrich(
    home: SourceHome,
    lease: HomeLease,
    signal: AbortSignal,
    deadline: number,
  ) {
    const candidates = [
      ...new Map(
        [
          ...home.featured.slice(0, 2),
          ...home.recentAnime.filter(
            (anime) => !anime.startDate || !anime.category || !anime.synopsis,
          ),
        ].map((anime) => [anime.slug, anime]),
      ).values(),
    ];
    // Two workers bound fan-out. Every queued entry checks the aggregate signal
    // before fetching, and failures cannot undo the already published core.
    let index = 0;
    await Promise.allSettled(
      Array.from({ length: Math.min(2, candidates.length) }, async () => {
        while (index < candidates.length && !signal.aborted) {
          const anime = candidates[index++];
          try {
            const detail = await this.source.getAnime(anime.slug, signal);
            signal.throwIfAborted();
            await this.store.enrichDetail(detail, lease, signal, deadline);
          } catch {
            /* Display metadata is best effort within this job's budget. */
          }
        }
      }),
    );
  }

  private dueMode(snapshots: HomeSnapshots): HomeRefreshMode | undefined {
    const missingOrExpired = (kind: SnapshotKind) => {
      const snapshot = snapshots.find((item) => item.kind === kind);
      return (
        !snapshot?.items.length ||
        snapshot.nextRefreshAt.getTime() <= Date.now()
      );
    };
    if (
      missingOrExpired(SnapshotKind.HOME_FEATURED) ||
      missingOrExpired(SnapshotKind.HOME_RECENT_ANIME)
    )
      return 'full';
    if (missingOrExpired(SnapshotKind.HOME_RECENT_EPISODES)) return 'recent';
    return undefined;
  }

  private loadSnapshots() {
    if (!this.readPromise) {
      this.readPromise = this.store.read().finally(() => {
        this.readPromise = undefined;
      });
    }
    return this.readPromise;
  }
}
