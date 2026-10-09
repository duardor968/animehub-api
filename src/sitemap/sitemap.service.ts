import { Injectable } from '@nestjs/common';
import { SourceAvailability } from '../generated/prisma/enums';
import { SitemapAnimeResponseDto } from '../common/contracts';
import { PrismaService } from '../prisma/prisma.service';

// One sitemap file holds at most 50 000 URLs (sitemaps.org protocol).
export const SITEMAP_MAX_ANIME = 50_000;

@Injectable()
export class SitemapService {
  constructor(private readonly prisma: PrismaService) {}

  async getAnime(): Promise<SitemapAnimeResponseDto> {
    const anime = await this.prisma.anime.findMany({
      where: { availability: SourceAvailability.AVAILABLE },
      orderBy: { slug: 'asc' },
      take: SITEMAP_MAX_ANIME,
      select: {
        slug: true,
        contentUpdatedAt: true,
        latestEpisodePublishedAt: true,
      },
    });
    return {
      data: anime.map((entry) => ({
        slug: entry.slug,
        updatedAt: latest(
          entry.contentUpdatedAt,
          entry.latestEpisodePublishedAt,
        ).toISOString(),
      })),
    };
  }
}

function latest(date: Date, other: Date | null) {
  return other && other > date ? other : date;
}
