import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  AnimeStatus,
  RelationKind,
  SnapshotKind,
  SourceAvailability,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  SourceAnimeDetail,
  SourceAnimeSummary,
  SourceEpisode,
  SourceRelation,
} from '../source/source.types';

export function nextAnimeRefresh(
  status: SourceAnimeSummary['status'],
  now: Date,
  unchangedRefreshes = 0,
) {
  const minutes =
    status === 'AIRING'
      ? 15
      : status === 'UPCOMING'
        ? 6 * 60
        : status === 'FINISHED'
          ? Math.min(30 * 2 ** unchangedRefreshes, 180) * 24 * 60
          : 24 * 60;
  return new Date(now.getTime() + minutes * 60_000);
}

@Injectable()
export class ProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertAnime(source: SourceAnimeSummary) {
    const now = new Date();
    const category = source.category
      ? await this.prisma.category.upsert({
          where: { slug: source.category.slug },
          update: { sourceId: source.category.id, name: source.category.name },
          create: {
            sourceId: source.category.id,
            name: source.category.name,
            slug: source.category.slug,
          },
        })
      : null;
    const anime = await this.prisma.anime.upsert({
      where: { sourceId: source.id },
      update: {
        slug: source.slug,
        title: source.title,
        synopsis: source.synopsis ?? undefined,
        posterUrl: source.posterUrl,
        backdropUrl: source.backdropUrl,
        status:
          source.status === 'UNKNOWN'
            ? undefined
            : (source.status as AnimeStatus),
        availability: SourceAvailability.AVAILABLE,
        categoryId: category?.id,
        startDate: source.startDate ?? undefined,
        mature: source.mature,
        sourceUrl: `https://animeav1.com/media/${source.slug}`,
        lastSeenAt: now,
        notFoundCount: 0,
      },
      create: {
        sourceId: source.id,
        slug: source.slug,
        title: source.title,
        synopsis: source.synopsis,
        posterUrl: source.posterUrl,
        backdropUrl: source.backdropUrl,
        status: source.status as AnimeStatus,
        categoryId: category?.id ?? null,
        startDate: source.startDate,
        mature: source.mature,
        sourceUrl: `https://animeav1.com/media/${source.slug}`,
        lastSeenAt: now,
        lastFetchedAt: now,
        nextRefreshAt: nextAnimeRefresh(source.status, now),
      },
    });

    if (source.genres.length > 0) {
      const genres = await Promise.all(
        source.genres.map((genre) =>
          this.prisma.genre.upsert({
            where: { slug: genre.slug },
            update: { sourceId: genre.id, name: genre.name },
            create: {
              sourceId: genre.id,
              name: genre.name,
              slug: genre.slug,
            },
          }),
        ),
      );
      await this.prisma.$transaction([
        this.prisma.animeGenre.deleteMany({ where: { animeId: anime.id } }),
        this.prisma.animeGenre.createMany({
          data: genres.map((genre) => ({
            animeId: anime.id,
            genreId: genre.id,
          })),
          skipDuplicates: true,
        }),
      ]);
    }
    return anime;
  }

  async upsertDetail(source: SourceAnimeDetail) {
    const anime = await this.upsertAnime(source);
    const now = new Date();
    const contentHash = createHash('sha256')
      .update(
        JSON.stringify({
          title: source.title,
          synopsis: source.synopsis,
          episodes: source.episodes.map((episode) => episode.id),
          relations: source.relations.map((relation) => relation.anime.id),
        }),
      )
      .digest('hex');
    const previous = await this.prisma.anime.findUniqueOrThrow({
      where: { id: anime.id },
      select: { contentHash: true, unchangedRefreshes: true },
    });
    await this.prisma.anime.update({
      where: { id: anime.id },
      data: {
        alternativeTitle: source.alternativeTitle,
        trailerUrl: source.trailerUrl,
        endDate: source.endDate,
        nextEpisodeAt: source.nextEpisodeAt,
        episodeCount: source.episodeCount,
        score: source.score,
        votes: source.votes,
        contentHash,
        detailFetchedAt: now,
        unchangedRefreshes:
          previous.contentHash === contentHash
            ? previous.unchangedRefreshes + 1
            : 0,
        lastFetchedAt: now,
        nextRefreshAt: nextAnimeRefresh(
          source.status,
          now,
          previous.contentHash === contentHash
            ? previous.unchangedRefreshes + 1
            : 0,
        ),
      },
    });

    for (const episode of source.episodes) {
      await this.upsertEpisode(anime.id, episode);
    }
    await this.replaceRelations(anime.id, source.relations);
    return anime;
  }

  async upsertEpisode(animeId: string, source: SourceEpisode) {
    return this.prisma.episode.upsert({
      where: { sourceId: source.id },
      update: {
        animeId,
        number: source.number,
        title: source.title,
        imageUrl: source.imageUrl,
        sourcePath: source.sourcePath,
        // Never overwrite a known publish time with null. The source's home/detail
        // endpoints intermittently return a freshly-aired episode with no createdAt
        // yet (the server sees this far more than a browser does); writing that null
        // here would blank the episode's timestamp and drop today's shows off the
        // schedule (which needs publishedAt to place a slot). A publish time only
        // ever goes null -> value, never back, so keeping the existing value is safe.
        publishedAt: source.publishedAt ?? undefined,
        lastSeenAt: new Date(),
      },
      create: {
        sourceId: source.id,
        animeId,
        number: source.number,
        title: source.title,
        imageUrl: source.imageUrl,
        sourcePath: source.sourcePath,
        publishedAt: source.publishedAt,
        lastSeenAt: new Date(),
      },
    });
  }

  async replaceSnapshot(
    key: string,
    kind: SnapshotKind,
    entries: Array<{
      animeId: string;
      episodeId?: string;
      label?: string;
    }>,
    options: {
      ttlMinutes: number;
      totalPages?: number;
      totalRecords?: number;
      minYear?: number;
      maxYear?: number;
      fetchedAt?: Date;
    },
  ) {
    // Callers replacing a logical group of snapshots can provide one timestamp
    // for the whole batch. For each snapshot, metadata and contents move as one
    // atomic unit: readers can observe either the previous complete version or
    // the new complete version, never new freshness metadata with old/empty rows.
    const now = options.fetchedAt ?? new Date();
    return this.prisma.$transaction(async (transaction) => {
      const snapshot = await transaction.snapshot.upsert({
        where: { key },
        update: {
          kind,
          fetchedAt: now,
          nextRefreshAt: new Date(now.getTime() + options.ttlMinutes * 60_000),
          totalPages: options.totalPages,
          totalRecords: options.totalRecords,
          minYear: options.minYear,
          maxYear: options.maxYear,
        },
        create: {
          key,
          kind,
          fetchedAt: now,
          nextRefreshAt: new Date(now.getTime() + options.ttlMinutes * 60_000),
          totalPages: options.totalPages,
          totalRecords: options.totalRecords,
          minYear: options.minYear,
          maxYear: options.maxYear,
        },
      });
      await transaction.snapshotItem.deleteMany({
        where: { snapshotId: snapshot.id },
      });
      await transaction.snapshotItem.createMany({
        data: entries.map((entry, position) => ({
          snapshotId: snapshot.id,
          animeId: entry.animeId,
          episodeId: entry.episodeId,
          label: entry.label,
          position,
        })),
      });
      return snapshot;
    });
  }

  async markNotFound(slug: string) {
    const anime = await this.prisma.anime.findUnique({ where: { slug } });
    if (!anime) return;
    const count = anime.notFoundCount + 1;
    await this.prisma.anime.update({
      where: { id: anime.id },
      data: {
        notFoundCount: count,
        availability:
          count >= 2
            ? SourceAvailability.UNAVAILABLE
            : SourceAvailability.AVAILABLE,
      },
    });
  }

  private async replaceRelations(animeId: string, relations: SourceRelation[]) {
    await this.prisma.animeRelation.deleteMany({
      where: { sourceAnimeId: animeId },
    });
    for (const [position, relation] of relations.entries()) {
      const target = await this.upsertAnime(relation.anime);
      await this.prisma.animeRelation.create({
        data: {
          sourceAnimeId: animeId,
          targetAnimeId: target.id,
          targetSourceId: relation.anime.id,
          targetSlug: relation.anime.slug,
          targetTitle: relation.anime.title,
          targetPosterUrl: relation.anime.posterUrl,
          targetYear: relation.anime.startDate?.getUTCFullYear(),
          kind: relation.kind as RelationKind,
          position,
        },
      });
    }
  }
}
