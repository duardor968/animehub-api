import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AnimeService } from '../anime/anime.service';
import { SnapshotKind } from '../generated/prisma/enums';
import { HomeResponseDto } from '../common/contracts';
import {
  serializeAnime,
  serializeEpisode,
  serializeFeatured,
} from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { SourceHome, SourceRecentEpisode } from '../source/source.types';

export const HOME_REQUEST_REFRESH_TIMEOUT_MS = 10_000;
export const HOME_RECENT_SNAPSHOT_TTL_MINUTES = 4;

const HOME_SNAPSHOT_KINDS = [
  SnapshotKind.HOME_FEATURED,
  SnapshotKind.HOME_RECENT_EPISODES,
  SnapshotKind.HOME_RECENT_ANIME,
] as const;

@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);
  private refreshPromise?: Promise<void>;
  private recentRefreshPromise?: Promise<void>;
  private sourcePromise?: Promise<SourceHome>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
    private readonly animeService: AnimeService,
  ) {}

  async getHome(): Promise<HomeResponseDto> {
    let snapshots = await this.loadSnapshots();
    const now = new Date();
    const featured = snapshots.find(
      (item) => item.kind === SnapshotKind.HOME_FEATURED,
    );
    const recentEpisodes = snapshots.find(
      (item) => item.kind === SnapshotKind.HOME_RECENT_EPISODES,
    );
    const recentAnime = snapshots.find(
      (item) => item.kind === SnapshotKind.HOME_RECENT_ANIME,
    );
    // The home always has featured + recent content: an absent OR empty featured
    // snapshot means we have nothing to show yet (cold cache, or a transient
    // source response), so fetch synchronously instead of rendering an empty hero.
    if (
      !featured ||
      featured.items.length === 0 ||
      !recentEpisodes ||
      !recentAnime
    ) {
      await this.waitForRefresh(this.refresh(), 'cold home refresh');
      snapshots = await this.loadSnapshots();
    } else if (
      featured.nextRefreshAt <= now ||
      recentAnime.nextRefreshAt <= now
    ) {
      // Unlike stale-while-revalidate, wait a bounded amount for the first
      // request after expiry. In the healthy case that visitor receives the new
      // episode immediately; on timeout/failure we deliberately fall back to the
      // last good snapshot while the single-flight refresh keeps running.
      await this.waitForRefresh(this.refresh(), 'expired home refresh');
      snapshots = await this.loadSnapshots();
    } else if (recentEpisodes.nextRefreshAt <= now) {
      await this.waitForRefresh(
        this.refreshRecentEpisodes(),
        'expired recent-episodes refresh',
      );
      snapshots = await this.loadSnapshots();
    }
    const byKind = new Map(
      snapshots.map((snapshot) => [snapshot.kind, snapshot]),
    );
    const metaSource = byKind.get(SnapshotKind.HOME_FEATURED);
    if (!metaSource)
      throw new ServiceUnavailableException('Home data is unavailable.');
    const responseNow = new Date();
    const metaSnapshots = HOME_SNAPSHOT_KINDS.flatMap((kind) => {
      const snapshot = byKind.get(kind);
      return snapshot ? [snapshot] : [];
    });
    const fetchedAt = new Date(
      Math.min(
        ...metaSnapshots.map((snapshot) => snapshot.fetchedAt.getTime()),
      ),
    );
    const nextRefreshAt = new Date(
      Math.min(
        ...metaSnapshots.map((snapshot) => snapshot.nextRefreshAt.getTime()),
      ),
    );
    return {
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
          metaSnapshots.length !== HOME_SNAPSHOT_KINDS.length ||
          nextRefreshAt <= responseNow,
      },
    };
  }

  private refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const home = await this.loadSourceHome();
      // A source response with no featured anime is anomalous; don't overwrite
      // the last good snapshots with it (that would serve an empty home). Keep
      // what we have and retry on the next cycle.
      if (home.featured.length === 0) {
        this.logger.warn(
          'Empty featured feed; keeping the last good Home snapshots.',
        );
        return;
      }
      const featured = await Promise.all(
        home.featured.map((anime) => this.projection.upsertAnime(anime)),
      );
      await Promise.allSettled(
        home.featured
          .slice(0, 2)
          .map((anime) => this.animeService.getAnime(anime.slug)),
      );
      const enrichedRecentAnime = await Promise.all(
        home.recentAnime.map(async (anime) => {
          if (anime.startDate && anime.category && anime.synopsis) return anime;
          try {
            return await this.source.getAnime(anime.slug);
          } catch {
            return anime;
          }
        }),
      );
      const recentAnime = await Promise.all(
        enrichedRecentAnime.map((anime) => this.projection.upsertAnime(anime)),
      );
      const recentEpisodes = await this.projectRecentEpisodes(
        home.recentEpisodes,
      );
      const fetchedAt = new Date();
      await Promise.all([
        this.projection.replaceSnapshot(
          'home:featured',
          SnapshotKind.HOME_FEATURED,
          featured.map((anime) => ({ animeId: anime.id })),
          { ttlMinutes: 15, fetchedAt },
        ),
        recentEpisodes.length > 0
          ? this.projection.replaceSnapshot(
              'home:recent-episodes',
              SnapshotKind.HOME_RECENT_EPISODES,
              recentEpisodes,
              {
                ttlMinutes: HOME_RECENT_SNAPSHOT_TTL_MINUTES,
                fetchedAt,
              },
            )
          : Promise.resolve(),
        this.projection.replaceSnapshot(
          'home:recent-anime',
          SnapshotKind.HOME_RECENT_ANIME,
          recentAnime.map((anime) => ({ animeId: anime.id })),
          { ttlMinutes: 15, fetchedAt },
        ),
      ]);
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  // A lightweight heartbeat only projects the fast-moving recent-episode feed.
  // It avoids the detail enrichment done by the full Home refresh, so a
  // three-minute cadence does not fan out into dozens of source requests.
  refreshRecentEpisodes() {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.recentRefreshPromise) return this.recentRefreshPromise;
    this.recentRefreshPromise = (async () => {
      const home = await this.loadSourceHome();
      const entries = await this.projectRecentEpisodes(home.recentEpisodes);
      if (entries.length === 0) {
        this.logger.warn(
          'Empty recent-episode feed; keeping last good Home snapshot.',
        );
        return;
      }
      await this.projection.replaceSnapshot(
        'home:recent-episodes',
        SnapshotKind.HOME_RECENT_EPISODES,
        entries,
        { ttlMinutes: HOME_RECENT_SNAPSHOT_TTL_MINUTES },
      );
    })().finally(() => {
      this.recentRefreshPromise = undefined;
    });
    return this.recentRefreshPromise;
  }

  private async projectRecentEpisodes(items: SourceRecentEpisode[]) {
    const entries: Array<{ animeId: string; episodeId: string }> = [];
    for (const item of items) {
      const anime = await this.projection.upsertAnime(item.anime);
      const episode = await this.projection.upsertEpisode(
        anime.id,
        item.episode,
      );
      if (item.episode.publishedAt) {
        await this.prisma.anime.update({
          where: { id: anime.id },
          data: { latestEpisodePublishedAt: item.episode.publishedAt },
        });
      }
      entries.push({ animeId: anime.id, episodeId: episode.id });
    }
    return entries;
  }

  private loadSourceHome() {
    if (this.sourcePromise) return this.sourcePromise;
    this.sourcePromise = this.source.getHome().finally(() => {
      this.sourcePromise = undefined;
    });
    return this.sourcePromise;
  }

  private async waitForRefresh(promise: Promise<void>, operation: string) {
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      promise.then(
        () => ({ kind: 'completed' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      new Promise<{ kind: 'timed-out' }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: 'timed-out' }),
          HOME_REQUEST_REFRESH_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === 'completed') return true;
    this.logger.warn(
      outcome.kind === 'timed-out'
        ? `${operation} timed out; serving the last good snapshot.`
        : `${operation} failed; serving the last good snapshot: ${
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
          }`,
    );
    return false;
  }

  private loadSnapshots() {
    return this.prisma.snapshot.findMany({
      where: {
        kind: {
          in: [...HOME_SNAPSHOT_KINDS],
        },
      },
      include: {
        items: {
          orderBy: { position: 'asc' as const },
          include: {
            anime: {
              include: {
                category: true,
                genres: { include: { genre: true } },
              },
            },
            episode: true,
          },
        },
      },
    });
  }
}
