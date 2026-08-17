import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SnapshotKind } from '../generated/prisma/enums';
import { ScheduleResponseDto } from '../common/contracts';
import { serializeAnime, serializeEpisode } from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';

// A still-airing series must never disappear from the board because the source
// momentarily omitted it — e.g. the Monday-morning rollover, when last week's
// "latest episode" briefly drops out before this week's is published, and
// getSchedule() silently discards entries with no latest episode. We carry such a
// show forward until the source has stopped listing it for at least this long.
// Each snapshot item's `label` stores the last time we actually saw the show from
// the source, so the window is wall-clock and independent of refresh cadence: a
// transient blip lasts seconds/minutes, never 6h, while a genuinely departed show
// stops being seen and ages out naturally (handling broadcast pauses too, since
// the source keeps listing paused shows).
export const SCHEDULE_RETENTION_MS = 6 * 60 * 60_000;

export interface RetainableScheduleItem {
  animeId: string;
  episodeId: string | null;
  label: string | null;
}

// Pure policy (unit-tested): given the anime ids the source returned this cycle,
// the previous snapshot's items and the current time, decide which
// previously-known shows to carry over so a transient omission never drops a
// still-airing series. A total-count guard cannot catch this (one day collapsing
// barely moves the total); tracking per-show presence over time does.
export function retainOmittedEntries(
  seenAnimeIds: Set<string>,
  previousItems: RetainableScheduleItem[],
  previousFetchedAt: Date,
  now: Date,
  retentionMs: number = SCHEDULE_RETENTION_MS,
): Array<{ animeId: string; episodeId?: string; label: string }> {
  const retained: Array<{
    animeId: string;
    episodeId?: string;
    label: string;
  }> = [];
  for (const item of previousItems) {
    if (seenAnimeIds.has(item.animeId)) continue;
    const parsed = item.label ? new Date(item.label) : null;
    const lastSeen =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : previousFetchedAt;
    if (now.getTime() - lastSeen.getTime() >= retentionMs) continue;
    retained.push({
      animeId: item.animeId,
      episodeId: item.episodeId ?? undefined,
      // Preserve the original last-seen stamp so the retention clock keeps
      // counting from when the source actually last listed the show.
      label: lastSeen.toISOString(),
    });
  }
  return retained;
}

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
    const now = new Date();
    // Block synchronously only when there is nothing usable to show: an absent or
    // empty snapshot (cold cache, or a transient/partial source response). The
    // weekly schedule is never legitimately empty. Otherwise serve instantly and
    // revalidate in the background — the board is near-static and its fast-moving
    // bits (aired status, episode number) are derived client-side, so a slightly
    // stale snapshot still renders correctly. Because the page is force-dynamic /
    // no-store, the background refresh's result surfaces on the very next request.
    if (!snapshot || snapshot.items.length === 0) {
      try {
        await this.refresh();
        snapshot = await this.load();
      } catch {
        // Source unavailable: fall through and let the guard below surface the
        // empty case rather than turning a usable snapshot into an error page.
      }
    } else if (snapshot.nextRefreshAt <= now) {
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
      // transient/partial fetch that returned nothing would poison the cache.
      if (source.length === 0) return;
      const now = new Date();
      const entries: Array<{
        animeId: string;
        episodeId?: string;
        label: string;
      }> = [];
      const seen = new Set<string>();
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
        seen.add(anime.id);
        entries.push({
          animeId: anime.id,
          episodeId: episode.id,
          label: now.toISOString(),
        });
      }
      // Carry over still-airing shows the source transiently omitted this cycle
      // (see SCHEDULE_RETENTION_MS) so none vanishes for a refresh cycle.
      const previous = await this.load();
      if (previous) {
        entries.push(
          ...retainOmittedEntries(
            seen,
            previous.items.map((item) => ({
              animeId: item.animeId,
              episodeId: item.episodeId,
              label: item.label,
            })),
            previous.fetchedAt,
            now,
          ),
        );
      }
      // The board changes ~once a day and its live bits are derived client-side,
      // so a short TTL only multiplied our exposure to the source's transient
      // states without improving freshness. Revalidate every 15 min instead.
      await this.projection.replaceSnapshot(
        'schedule:weekly',
        SnapshotKind.SCHEDULE,
        entries,
        { ttlMinutes: 15 },
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
