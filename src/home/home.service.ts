import { Injectable, ServiceUnavailableException } from '@nestjs/common';
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

@Injectable()
export class HomeService {
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
    private readonly animeService: AnimeService,
  ) {}

  async getHome(): Promise<HomeResponseDto> {
    let snapshots = await this.loadSnapshots();
    const featured = snapshots.find((item) => item.kind === 'HOME_FEATURED');
    if (!featured) {
      await this.refresh();
      snapshots = await this.loadSnapshots();
    } else if (featured.nextRefreshAt <= new Date()) {
      void this.refresh();
    }
    const byKind = new Map(
      snapshots.map((snapshot) => [snapshot.kind, snapshot]),
    );
    const metaSource = byKind.get('HOME_FEATURED');
    if (!metaSource)
      throw new ServiceUnavailableException('Home data is unavailable.');
    return {
      data: {
        featured: (byKind.get('HOME_FEATURED')?.items ?? []).map(({ anime }) =>
          serializeFeatured(anime),
        ),
        recentEpisodes: (
          byKind.get('HOME_RECENT_EPISODES')?.items ?? []
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
        recentAnime: (byKind.get('HOME_RECENT_ANIME')?.items ?? []).map(
          ({ anime }) => serializeAnime(anime),
        ),
      },
      meta: {
        fetchedAt: metaSource.fetchedAt.toISOString(),
        nextRefreshAt: metaSource.nextRefreshAt.toISOString(),
        stale: metaSource.nextRefreshAt <= new Date(),
      },
    };
  }

  private async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const home = await this.source.getHome();
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
      const recentEpisodes = [];
      for (const item of home.recentEpisodes) {
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
        recentEpisodes.push({ animeId: anime.id, episodeId: episode.id });
      }
      await Promise.all([
        this.projection.replaceSnapshot(
          'home:featured',
          SnapshotKind.HOME_FEATURED,
          featured.map((anime) => ({ animeId: anime.id })),
          { ttlMinutes: 15 },
        ),
        this.projection.replaceSnapshot(
          'home:recent-episodes',
          SnapshotKind.HOME_RECENT_EPISODES,
          recentEpisodes,
          { ttlMinutes: 15 },
        ),
        this.projection.replaceSnapshot(
          'home:recent-anime',
          SnapshotKind.HOME_RECENT_ANIME,
          recentAnime.map((anime) => ({ animeId: anime.id })),
          { ttlMinutes: 15 },
        ),
      ]);
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private loadSnapshots() {
    return this.prisma.snapshot.findMany({
      where: {
        kind: {
          in: [
            SnapshotKind.HOME_FEATURED,
            SnapshotKind.HOME_RECENT_EPISODES,
            SnapshotKind.HOME_RECENT_ANIME,
          ],
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
