import { Injectable } from '@nestjs/common';
import { AudioType, DownloadProvider } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { AnimeAv1Service } from '../source/animeav1.service';
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

export function linkTtlMinutes(
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
  if (!publishedAt) return 15;
  const age = now - publishedAt.getTime();
  if (age <= 2 * 24 * 60 * 60_000) return 15;
  if (age <= 7 * 24 * 60 * 60_000) return 60;
  return 24 * 60;
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly animeService: AnimeService,
    private readonly source: AnimeAv1Service,
  ) {}

  async resolve(
    slug: string,
    request: ResolveDownloadsDto,
  ): Promise<ResolveDownloadsResponseDto> {
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
        ),
      ),
    );
    return { data: { packageName: anime.title, episodes } };
  }

  async resolveEpisode(
    animeId: string,
    slug: string,
    number: number,
    requestedAudio: RequestedAudioDto,
    providers: ProviderDto[],
    forceRefresh = false,
  ): Promise<ResolvedEpisodeDto> {
    const episode = await this.prisma.episode.findUnique({
      where: { animeId_number: { animeId, number } },
      include: { links: true, downloadProbe: true },
    });
    if (!episode) {
      return {
        episodeNumber: number,
        audio: requestedAudio,
        links: [],
        errorCode: 'EPISODE_NOT_FOUND',
      };
    }
    const now = new Date();
    let links = episode.links.filter((link) => link.expiresAt > now);
    if (
      forceRefresh ||
      !episode.downloadProbe ||
      episode.downloadProbe.expiresAt <= now
    ) {
      const source = await this.source.getEpisodeDownloads(slug, number);
      const ttl = linkTtlMinutes(
        episode.publishedAt,
        source.links.length === 0,
      );
      const expiresAt = new Date(now.getTime() + ttl * 60_000);
      await this.prisma.$transaction([
        this.prisma.downloadLink.deleteMany({
          where: { episodeId: episode.id },
        }),
        this.prisma.downloadLink.createMany({
          data: source.links.map((link) => ({
            episodeId: episode.id,
            audio: link.audio as AudioType,
            provider: link.provider as DownloadProvider,
            url: link.url,
            fetchedAt: now,
            expiresAt,
          })),
        }),
        this.prisma.downloadProbe.upsert({
          where: { episodeId: episode.id },
          update: { fetchedAt: now, expiresAt },
          create: { episodeId: episode.id, fetchedAt: now, expiresAt },
        }),
      ]);
      links = await this.prisma.downloadLink.findMany({
        where: { episodeId: episode.id, expiresAt: { gt: now } },
      });
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
}
