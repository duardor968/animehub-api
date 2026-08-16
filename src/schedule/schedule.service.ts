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

  // How long a stale snapshot may still be served instantly while it
  // revalidates in the background. Past this the data is too old to trust for a
  // live schedule (nobody has visited in a while, so it can predate the source's
  // latest state), so we block and refresh to render correctly on the first hit.
  private static readonly MAX_SERVE_STALE_MS = 10 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {}

  async getSchedule(): Promise<ScheduleResponseDto> {
    let snapshot = await this.load();
    const now = new Date();
    // Block-and-fetch synchronously when either we have nothing usable — an
    // absent OR zero-item snapshot (a cold cache or a transient/partial source
    // response); the weekly schedule is never legitimately empty — or the
    // snapshot is stale beyond the grace window, i.e. so old (nobody visited in a
    // while) that it can predate the source's current state and show an
    // outdated/empty day. Within the grace window a stale snapshot is still
    // served instantly and revalidated in the background.
    const empty = !snapshot || snapshot.items.length === 0;
    const staleBeyondGrace =
      !!snapshot &&
      snapshot.nextRefreshAt <= now &&
      now.getTime() - snapshot.fetchedAt.getTime() >
        ScheduleService.MAX_SERVE_STALE_MS;
    if (empty || staleBeyondGrace) {
      try {
        await this.refresh();
        snapshot = await this.load();
      } catch {
        // Source unavailable: fall through and serve whatever we already loaded
        // (the last good snapshot). Blocking must never turn a usable-but-stale
        // schedule into an error page; the guard below handles the truly-empty
        // case where there is genuinely nothing to show.
      }
    } else if (snapshot && snapshot.nextRefreshAt <= now) {
      void this.refresh();
    }
    if (!snapshot || snapshot.items.length === 0)
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
      // Never clobber the last good snapshot with an empty source response: a
      // transient/partial fetch that returned nothing would otherwise poison the
      // cache and be served as an empty schedule. Keep what we have and retry.
      if (source.length === 0) return;
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
