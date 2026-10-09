import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SnapshotKind } from '../generated/prisma/enums';
import { ScheduleResponseDto } from '../common/contracts';
import { serializeAnime, serializeEpisode } from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { SourceEpisode } from '../source/source.types';

// Bound transient omissions per series, never against a season-wide count.
export const SCHEDULE_RETENTION_MS = 6 * 60 * 60_000;
// The API is timezone-neutral. Clients keep finales only on their local date.
const FINALE_WINDOW_MS = 48 * 60 * 60_000;
// AnimeAV1 keeps listing series on /horario long after their weekly cadence
// stops (seasonal breaks, theatrical-chapter releases such as Yamato 3199 last
// published 11 months earlier). After three missed weekly slots an entry no
// longer describes a weekly airing, so it is left out instead of reading as
// "delayed" forever. A new publication brings it back automatically.
export const SCHEDULE_STALE_AFTER_MS = 21 * 24 * 60 * 60_000;

export function isStaleScheduleEntry(publishedAt: Date, now: Date) {
  return now.getTime() - publishedAt.getTime() > SCHEDULE_STALE_AFTER_MS;
}

export interface RetainableScheduleItem {
  animeId: string;
  episodeId: string | null;
  label: string | null;
}

export function retainOmittedEntries(
  seenAnimeIds: Set<string>,
  previousItems: RetainableScheduleItem[],
  previousFetchedAt: Date,
  now: Date,
  retentionMs: number = SCHEDULE_RETENTION_MS,
): Array<{ animeId: string; episodeId?: string; label: string }> {
  return previousItems.flatMap((item) => {
    if (seenAnimeIds.has(item.animeId)) return [];
    const parsed = item.label ? new Date(item.label) : null;
    const lastSeen =
      parsed && Number.isFinite(parsed.getTime()) ? parsed : previousFetchedAt;
    if (now.getTime() - lastSeen.getTime() >= retentionMs) return [];
    return [
      {
        animeId: item.animeId,
        episodeId: item.episodeId ?? undefined,
        label: lastSeen.toISOString(),
      },
    ];
  });
}

function isFinalEpisode(
  anime: { status: string; episodeCount: number | null },
  episode: { number: number },
) {
  return (
    anime.status === 'FINISHED' &&
    anime.episodeCount !== null &&
    anime.episodeCount > 0 &&
    episode.number >= anime.episodeCount
  );
}

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {}

  async getSchedule(): Promise<ScheduleResponseDto> {
    let snapshot = await this.load();
    if (!snapshot || snapshot.nextRefreshAt <= new Date()) {
      // A visitor after expiry should see the refreshed roster, not another
      // stale response. A failing/slow source can still use the stored snapshot.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.refresh(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Schedule refresh timed out')),
              10_000,
            );
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        this.logger.warn(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
      snapshot = await this.load();
    }
    // An empty, successfully fetched week is valid between seasons.
    if (!snapshot)
      throw new ServiceUnavailableException('Schedule is unavailable.');
    const now = new Date();
    return {
      data: snapshot.items.flatMap(({ anime, episode }) =>
        episode?.publishedAt && !isStaleScheduleEntry(episode.publishedAt, now)
          ? [
              {
                anime: serializeAnime(anime),
                latestEpisode: serializeEpisode(episode),
                basisPublishedAt: episode.publishedAt.toISOString(),
                isFinalEpisode: isFinalEpisode(anime, episode),
              },
            ]
          : [],
      ),
      meta: {
        fetchedAt: snapshot.fetchedAt.toISOString(),
        nextRefreshAt: snapshot.nextRefreshAt.toISOString(),
        stale: snapshot.nextRefreshAt <= now,
      },
    };
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshSnapshot().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async refreshSnapshot() {
    // Invalid responses/network failures throw in the source parser. A valid
    // smaller (even empty) roster is not evidence of an outage.
    const source = await this.source.getSchedule();
    const previous = await this.load();
    const now = new Date();
    const entries = new Map<
      string,
      { animeId: string; episodeId?: string; label: string }
    >();
    for (const item of source) {
      const anime = await this.projection.upsertAnime(item.anime);
      const episode = item.episode?.publishedAt
        ? await this.observeEpisode(anime.id, item.episode)
        : await this.prisma.episode.findFirst({
            where: { animeId: anime.id, publishedAt: { not: null } },
            orderBy: { number: 'desc' },
          });
      if (!episode) continue;
      entries.set(anime.id, {
        animeId: anime.id,
        episodeId: episode.id,
        label: now.toISOString(),
      });
    }

    // The source removes completed shows from /horario on their final day.
    // Its recent-publication feed supplies the actual final episode timestamp.
    // Refresh details only after a new publication, including an early FINISHED
    // flag that still points at the penultimate episode.
    const recent = await this.source.getHome().then(
      (home) => home.recentEpisodes,
      (error: unknown) => {
        this.logger.warn(
          `Recent schedule releases unavailable: ${String(error)}`,
        );
        return [];
      },
    );
    for (const item of recent) {
      const publishedAt = item.episode.publishedAt;
      if (
        !publishedAt ||
        publishedAt > now ||
        now.getTime() - publishedAt.getTime() >= FINALE_WINDOW_MS
      )
        continue;
      const anime = await this.projection.upsertAnime(item.anime);
      const episode = await this.observeEpisode(anime.id, item.episode);
      let metadata: { status: string; episodeCount: number | null } = anime;
      if (!anime.detailFetchedAt || anime.detailFetchedAt < publishedAt) {
        const detail = await this.source
          .getAnime(item.anime.slug)
          .catch((error: unknown) => {
            this.logger.warn(
              `Finale detail refresh failed for ${item.anime.slug}: ${String(error)}`,
            );
            return null;
          });
        if (detail) {
          await this.projection.upsertDetail(detail);
          metadata = detail;
        }
      }
      if (isFinalEpisode(metadata, episode) || entries.has(anime.id)) {
        // Never regress to an earlier episode when a batch contains several.
        const current = entries.get(anime.id);
        const latest = await this.prisma.episode.findFirst({
          where: { animeId: anime.id, publishedAt: { not: null } },
          orderBy: { number: 'desc' },
        });
        entries.set(anime.id, {
          animeId: anime.id,
          episodeId: latest?.id ?? episode.id,
          label: current?.label ?? now.toISOString(),
        });
      }
    }

    if (previous) {
      for (const item of previous.items) {
        if (entries.has(item.animeId)) continue;
        if (
          item.episode?.publishedAt &&
          isFinalEpisode(item.anime, item.episode)
        ) {
          if (
            now.getTime() - item.episode.publishedAt.getTime() <
            FINALE_WINDOW_MS
          ) {
            entries.set(item.animeId, {
              animeId: item.animeId,
              episodeId: item.episode.id,
              label: item.label ?? previous.fetchedAt.toISOString(),
            });
          }
        } else if (item.anime.status !== 'FINISHED') {
          for (const retained of retainOmittedEntries(
            new Set(entries.keys()),
            [item],
            previous.fetchedAt,
            now,
          )) {
            entries.set(retained.animeId, retained);
          }
        }
      }
    }
    await this.projection.replaceSnapshot(
      'schedule:weekly',
      SnapshotKind.SCHEDULE,
      [...entries.values()],
      { ttlMinutes: 15 },
    );
  }

  private load() {
    return this.prisma.snapshot.findUnique({
      where: { key: 'schedule:weekly' },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: { anime: { include: { category: true } }, episode: true },
        },
      },
    });
  }

  private async observeEpisode(animeId: string, source: SourceEpisode) {
    const episode = await this.projection.upsertEpisode(animeId, source);
    if (source.publishedAt) {
      await this.prisma.anime.updateMany({
        where: {
          id: animeId,
          OR: [
            { latestEpisodePublishedAt: null },
            { latestEpisodePublishedAt: { lt: source.publishedAt } },
          ],
        },
        data: { latestEpisodePublishedAt: source.publishedAt },
      });
    }
    return episode;
  }
}
