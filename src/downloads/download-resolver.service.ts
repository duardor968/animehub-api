import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
  AnimeAv1UnavailableError,
} from '../source/animeav1.service';
import { sourceDeadline, waitForSource } from '../source/source-wait';
import { AnimeService } from '../anime/anime.service';
import {
  ProviderDto,
  RequestedAudioDto,
  ResolveDownloadsDto,
  ResolveDownloadsResponseDto,
  ResolvedEpisodeDto,
} from './download.dto';

interface CandidateLink {
  audio: string;
  provider: string;
  url: string;
}

type StoredEpisode = Prisma.EpisodeGetPayload<{
  include: { links: true; downloadProbe: true };
}>;

// Dubs reach the source weeks after the episode: a request for an audio the
// cached links lack re-probes once they are this old.
export const MISSING_AUDIO_RECHECK_MS = 60 * 60_000;

/**
 * Minutes the links of an episode stay cached. Links that went unchanged for a
 * while rarely change again, so they stay a fifth of the time they have been
 * stable (`stableSince`), from 15 min (an episode whose mirrors still arrive,
 * in its first hours) to 7 days.
 */
export function linkTtlMinutes(
  stableSince: Date,
  publishedAt: Date | null,
  empty: boolean,
  now = Date.now(),
) {
  if (empty) {
    // A just-published episode often has no mirrors for a few minutes while the
    // source populates them. Caching that emptiness for long makes retries keep
    // failing after the links appear, so recent episodes get a very short TTL
    // (~30s) to re-probe quickly; older ones with no links stay cached longer.
    const recent =
      publishedAt !== null &&
      now - publishedAt.getTime() <= 2 * 24 * 60 * 60_000;
    return recent ? 0.5 : 2;
  }
  const stableMinutes = (now - stableSince.getTime()) / 60_000;
  return Math.min(Math.max(stableMinutes / 5, 15), 7 * 24 * 60);
}

const linkKey = (link: CandidateLink) =>
  `${link.audio}|${link.provider}|${link.url}`;

export function selectDownloadLinks<T extends CandidateLink>(
  links: T[],
  requestedAudio: RequestedAudioDto,
  providers: ProviderDto[],
) {
  const providerSet = new Set(providers as string[]);
  const requestedAudioValue: string = requestedAudio;
  const preferred = links.filter(
    (link) =>
      link.audio === requestedAudioValue && providerSet.has(link.provider),
  );
  const alternateAudio: string =
    requestedAudio === RequestedAudioDto.SUB
      ? RequestedAudioDto.DUB
      : RequestedAudioDto.SUB;
  return preferred.length > 0
    ? preferred
    : links.filter(
        (link) =>
          link.audio === alternateAudio && providerSet.has(link.provider),
      );
}

@Injectable()
export class DownloadResolverService {
  // One refresh per episode at a time: the Web resolves on hover, and a late
  // refresh keeps running after its request served the stored links.
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly animeService: AnimeService,
    private readonly source: AnimeAv1Service,
  ) {}

  async resolve(
    slug: string,
    request: ResolveDownloadsDto,
  ): Promise<ResolveDownloadsResponseDto> {
    const deadline = sourceDeadline();
    const anime = await this.animeService.ensureAnime(slug);
    const uniqueNumbers = [...new Set(request.episodeNumbers)].sort(
      (a, b) => a - b,
    );
    const episodes = await Promise.all(
      uniqueNumbers.map((number) =>
        this.resolveEpisode(
          anime.id,
          slug,
          number,
          request.audio,
          request.providers,
          Boolean(request.refresh),
          deadline,
        ).catch((error: unknown): ResolvedEpisodeDto => {
          // One slow/failed mirror page must not discard the other results.
          if (!(error instanceof AnimeAv1UnavailableError)) throw error;
          return {
            episodeNumber: number,
            audio: request.audio,
            links: [],
            errorCode: 'SOURCE_UNAVAILABLE',
          };
        }),
      ),
    );
    if (
      episodes.every((episode) => episode.errorCode === 'SOURCE_UNAVAILABLE')
    ) {
      throw new ServiceUnavailableException(
        'AnimeAV1 is temporarily unavailable.',
      );
    }
    return { data: { packageName: anime.title, episodes } };
  }

  /**
   * Resolves an episode from its cached links, refreshing them from the source
   * when they expired, when `forceRefresh`, or when they lack the requested
   * audio and are older than MISSING_AUDIO_RECHECK_MS. When the source fails,
   * or is still answering at `deadline`, the stored links are served even if
   * expired; only an episode with none stored fails.
   */
  async resolveEpisode(
    animeId: string,
    slug: string,
    number: number,
    requestedAudio: RequestedAudioDto,
    providers: ProviderDto[],
    forceRefresh = false,
    deadline?: number,
  ): Promise<ResolvedEpisodeDto> {
    const notFound: ResolvedEpisodeDto = {
      episodeNumber: number,
      audio: requestedAudio,
      links: [],
      errorCode: 'EPISODE_NOT_FOUND',
    };
    const episode = await this.prisma.episode.findUnique({
      where: { animeId_number: { animeId, number } },
      include: { links: true, downloadProbe: true },
    });
    if (!episode) return notFound;
    const now = new Date();
    const probe = episode.downloadProbe;
    let links = episode.links.filter((link) => link.expiresAt > now);
    const audio: string = requestedAudio;
    const lacksAudio = !links.some((link) => link.audio === audio);
    if (
      forceRefresh ||
      !probe ||
      probe.expiresAt <= now ||
      (lacksAudio &&
        now.getTime() - probe.fetchedAt.getTime() >= MISSING_AUDIO_RECHECK_MS)
    ) {
      const refresh = this.refreshLinks(episode, slug, number);
      let refreshed = false;
      try {
        if (deadline === undefined) {
          await refresh;
          refreshed = true;
        } else {
          refreshed = await waitForSource(refresh, deadline);
        }
      } catch (error) {
        // Known locally but gone at the source (renumbered or removed).
        if (error instanceof AnimeAv1NotFoundError) return notFound;
        if (!(error instanceof AnimeAv1UnavailableError)) throw error;
      }
      if (refreshed) {
        links = await this.prisma.downloadLink.findMany({
          where: { episodeId: episode.id, expiresAt: { gt: now } },
        });
      } else if (episode.links.length > 0) {
        links = episode.links;
      } else {
        throw new AnimeAv1UnavailableError(
          `No links stored for ${slug} episode ${number}`,
        );
      }
    }
    const selected = selectDownloadLinks(links, requestedAudio, providers);
    return {
      episodeNumber: number,
      audio: (selected[0]?.audio ?? requestedAudio) as RequestedAudioDto,
      links: selected.map((link) => ({
        provider: link.provider as ProviderDto,
        url: link.url,
      })),
      errorCode: selected.length > 0 ? null : 'NO_SUPPORTED_LINKS',
    };
  }

  private refreshLinks(episode: StoredEpisode, slug: string, number: number) {
    const active = this.refreshes.get(episode.id);
    if (active) return active;
    const promise = (async () => {
      const source = await this.source.getEpisodeDownloads(slug, number);
      const now = new Date();
      const fresh = new Set(source.links.map(linkKey));
      const unchanged =
        fresh.size === episode.links.length &&
        episode.links.every((link) => fresh.has(linkKey(link)));
      // First probe: assume the links stand since the episode was published,
      // or, without a date, since this API first saw it.
      const stableSince = !episode.downloadProbe
        ? (episode.publishedAt ?? episode.createdAt)
        : unchanged
          ? episode.downloadProbe.stableSince
          : now;
      const ttl = linkTtlMinutes(
        stableSince,
        episode.publishedAt,
        source.links.length === 0,
        now.getTime(),
      );
      const expiresAt = new Date(now.getTime() + ttl * 60_000);
      await this.prisma.$transaction([
        this.prisma.downloadLink.deleteMany({
          where: { episodeId: episode.id },
        }),
        this.prisma.downloadLink.createMany({
          data: source.links.map((link) => ({
            episodeId: episode.id,
            audio: link.audio,
            provider: link.provider,
            url: link.url,
            fetchedAt: now,
            expiresAt,
          })),
        }),
        this.prisma.downloadProbe.upsert({
          where: { episodeId: episode.id },
          update: { fetchedAt: now, expiresAt, stableSince },
          create: {
            episodeId: episode.id,
            fetchedAt: now,
            expiresAt,
            stableSince,
          },
        }),
      ]);
    })().finally(() => this.refreshes.delete(episode.id));
    this.refreshes.set(episode.id, promise);
    return promise;
  }
}
