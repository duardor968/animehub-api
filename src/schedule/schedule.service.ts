import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SnapshotKind } from '../generated/prisma/enums';
import { ScheduleResponseDto } from '../common/contracts';
import { serializeAnime, serializeEpisode } from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';

@Injectable()
export class ScheduleService {
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {}

  async getSchedule(): Promise<ScheduleResponseDto> {
    let snapshot = await this.load();
    if (!snapshot) {
      await this.refresh();
      snapshot = await this.load();
    } else if (snapshot.nextRefreshAt <= new Date()) {
      void this.refresh();
    }
    if (!snapshot)
      throw new ServiceUnavailableException('Schedule is unavailable.');
    return {
      data: snapshot.items.flatMap(({ anime, episode }) =>
        episode?.publishedAt
          ? [
              {
                anime: serializeAnime(anime),
                latestEpisode: serializeEpisode(episode),
                basisPublishedAt: episode.publishedAt.toISOString(),
              },
            ]
          : [],
      ),
      meta: {
        fetchedAt: snapshot.fetchedAt.toISOString(),
        nextRefreshAt: snapshot.nextRefreshAt.toISOString(),
        stale: snapshot.nextRefreshAt <= new Date(),
      },
    };
  }

  private async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const source = await this.source.getSchedule();
      const entries = [];
      for (const item of source) {
        const anime = await this.projection.upsertAnime(item.anime);
        const episode = await this.projection.upsertEpisode(
          anime.id,
          item.episode,
        );
        await this.prisma.anime.update({
          where: { id: anime.id },
          data: { latestEpisodePublishedAt: item.episode.publishedAt },
        });
        entries.push({ animeId: anime.id, episodeId: episode.id });
      }
      // The schedule is volatile (animeav1 is live), so keep the snapshot short:
      // serve it for ~1 min, then revalidate in the background on the next hit.
      await this.projection.replaceSnapshot(
        'schedule:weekly',
        SnapshotKind.SCHEDULE,
        entries,
        { ttlMinutes: 1 },
      );
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private load() {
    return this.prisma.snapshot.findUnique({
      where: { key: 'schedule:weekly' },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: {
            anime: { include: { category: true } },
            episode: true,
          },
        },
      },
    });
  }
}
