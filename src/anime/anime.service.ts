import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AnimeResponseDto, EpisodePageResponseDto } from '../common/contracts';
import { serializeDetail, serializeEpisode } from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
} from '../source/animeav1.service';

const detailInclude = {
  category: true,
  genres: { include: { genre: true } },
  outgoingRelations: {
    orderBy: { position: 'asc' as const },
    include: { targetAnime: { include: { category: true } } },
  },
};

@Injectable()
export class AnimeService {
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {}

  async getAnime(slug: string): Promise<AnimeResponseDto> {
    let anime = await this.prisma.anime.findUnique({
      where: { slug },
      include: detailInclude,
    });
    if (!anime) {
      await this.refresh(slug);
      anime = await this.prisma.anime.findUnique({
        where: { slug },
        include: detailInclude,
      });
    } else if (!anime.detailFetchedAt) {
      await this.refresh(slug);
      anime = await this.prisma.anime.findUnique({
        where: { slug },
        include: detailInclude,
      });
    } else if (anime.nextRefreshAt <= new Date()) {
      void this.refresh(slug);
    }
    if (!anime) throw new NotFoundException('Anime not found.');
    if (anime.availability === 'UNAVAILABLE') {
      throw new NotFoundException(
        'Anime is no longer available at the source.',
      );
    }
    return {
      data: serializeDetail(anime),
      meta: {
        fetchedAt: (anime.detailFetchedAt ?? anime.lastFetchedAt).toISOString(),
        nextRefreshAt: anime.nextRefreshAt.toISOString(),
        stale: anime.nextRefreshAt <= new Date(),
      },
    };
  }

  async getEpisodes(
    slug: string,
    page: number,
  ): Promise<EpisodePageResponseDto> {
    await this.getAnime(slug);
    const anime = await this.prisma.anime.findUniqueOrThrow({
      where: { slug },
    });
    const perPage = 50;
    const [episodes, totalRecords] = await Promise.all([
      this.prisma.episode.findMany({
        where: { animeId: anime.id },
        orderBy: { number: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.episode.count({ where: { animeId: anime.id } }),
    ]);
    return {
      data: episodes.map(serializeEpisode),
      meta: {
        page,
        perPage,
        totalPages: Math.ceil(totalRecords / perPage),
        totalRecords,
      },
    };
  }

  async ensureAnime(slug: string) {
    await this.getAnime(slug);
    return this.prisma.anime.findUniqueOrThrow({ where: { slug } });
  }

  private refresh(slug: string) {
    const active = this.refreshes.get(slug);
    if (active) return active;
    const promise = (async () => {
      try {
        const source = await this.source.getAnime(slug);
        await this.projection.upsertDetail(source);
      } catch (error) {
        if (error instanceof AnimeAv1NotFoundError) {
          await this.projection.markNotFound(slug);
          const cached = await this.prisma.anime.findUnique({
            where: { slug },
          });
          if (!cached) throw new NotFoundException('Anime not found.');
          return;
        }
        const cached = await this.prisma.anime.findUnique({ where: { slug } });
        if (!cached) {
          throw new ServiceUnavailableException(
            'AnimeAV1 is temporarily unavailable.',
          );
        }
      }
    })().finally(() => this.refreshes.delete(slug));
    this.refreshes.set(slug, promise);
    return promise;
  }
}
