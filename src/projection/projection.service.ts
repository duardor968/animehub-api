import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SnapshotKind, SourceAvailability } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  SourceAnimeDetail,
  SourceAnimeSummary,
  SourceCategory,
  SourceEpisode,
  SourceRelation,
} from '../source/source.types';

/** Moves an anime's latestEpisodePublishedAt forward, never back. */
export function latestEpisodeUpdate(animeId: string, publishedAt: Date) {
  return {
    where: {
      id: animeId,
      OR: [
        { latestEpisodePublishedAt: null },
        { latestEpisodePublishedAt: { lt: publishedAt } },
      ],
    },
    data: { latestEpisodePublishedAt: publishedAt },
  };
}

/** Upsert of a category or genre, both keyed by slug. */
export function bySlug({ id, name, slug }: SourceCategory) {
  return {
    where: { slug },
    update: { sourceId: id, name },
    create: { sourceId: id, name, slug },
  };
}

export function nextAnimeRefresh(
  status: SourceAnimeSummary['status'],
  now: Date,
  unchangedRefreshes = 0,
) {
  // A paused series' return is due like a premiere.
  const minutes =
    status === 'AIRING'
      ? 15
      : status === 'UPCOMING' || status === 'PAUSED'
        ? 6 * 60
        : status === 'FINISHED'
          ? Math.min(30 * 2 ** unchangedRefreshes, 180) * 24 * 60
          : 24 * 60;
  return new Date(now.getTime() + minutes * 60_000);
}

@Injectable()
export class ProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertAnime(
    source: SourceAnimeSummary,
    transaction?: Prisma.TransactionClient,
  ) {
    const client = transaction ?? this.prisma;
    const now = new Date();
    const category = source.category
      ? await client.category.upsert(bySlug(source.category))
      : null;
    const seen = {
      slug: source.slug,
      title: source.title,
      posterUrl: source.posterUrl,
      backdropUrl: source.backdropUrl,
      mature: source.mature,
      sourceUrl: `https://animeav1.com/media/${source.slug}`,
      lastSeenAt: now,
    };
    const anime = await client.anime.upsert({
      where: { sourceId: source.id },
      // A summary missing a field keeps the stored value.
      update: {
        ...seen,
        synopsis: source.synopsis ?? undefined,
        status: source.status === 'UNKNOWN' ? undefined : source.status,
        availability: SourceAvailability.AVAILABLE,
        categoryId: category?.id,
        startDate: source.startDate ?? undefined,
        notFoundCount: 0,
      },
      create: {
        ...seen,
        sourceId: source.id,
        synopsis: source.synopsis,
        status: source.status,
        categoryId: category?.id ?? null,
        startDate: source.startDate,
        lastFetchedAt: now,
        nextRefreshAt: nextAnimeRefresh(source.status, now),
      },
    });

    if (source.genres.length > 0) {
      const genres = await Promise.all(
        source.genres.map((genre) => client.genre.upsert(bySlug(genre))),
      );
      const replaceGenres = async (tx: Prisma.TransactionClient) => {
        await tx.animeGenre.deleteMany({ where: { animeId: anime.id } });
        await tx.animeGenre.createMany({
          data: genres.map((genre) => ({
            animeId: anime.id,
            genreId: genre.id,
          })),
          skipDuplicates: true,
        });
      };
      if (transaction) await replaceGenres(transaction);
      else await this.prisma.$transaction(replaceGenres);
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
          relations: source.relations.map((relation) => [
            relation.anime.id,
            relation.kind,
          ]),
        }),
      )
      .digest('hex');
    const previous = await this.prisma.anime.findUniqueOrThrow({
      where: { id: anime.id },
      select: { contentHash: true, unchangedRefreshes: true },
    });
    const contentChanged = previous.contentHash !== contentHash;
    for (const episode of source.episodes) {
      await this.upsertEpisode(anime.id, episode);
    }
    await this.replaceRelations(anime.id, source.relations);
    await this.prisma.anime.update({
      where: { id: anime.id },
      data: {
        ...(contentChanged ? { contentUpdatedAt: now } : {}),
        alternativeTitle: source.alternativeTitle,
        trailerUrl: source.trailerUrl,
        endDate: source.endDate,
        nextEpisodeAt: source.nextEpisodeAt,
        episodeCount: source.episodeCount,
        score: source.score,
        votes: source.votes,
        contentHash,
        detailFetchedAt: now,
        unchangedRefreshes: contentChanged
          ? 0
          : previous.unchangedRefreshes + 1,
        lastFetchedAt: now,
        nextRefreshAt: nextAnimeRefresh(
          source.status,
          now,
          contentChanged ? 0 : previous.unchangedRefreshes + 1,
        ),
      },
    });

    return anime;
  }

  async upsertEpisode(
    animeId: string,
    source: SourceEpisode,
    transaction?: Prisma.TransactionClient,
  ) {
    return (transaction ?? this.prisma).episode.upsert({
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
    const data = {
      kind,
      fetchedAt: now,
      nextRefreshAt: new Date(now.getTime() + options.ttlMinutes * 60_000),
      totalPages: options.totalPages,
      totalRecords: options.totalRecords,
      minYear: options.minYear,
      maxYear: options.maxYear,
    };
    return this.prisma.$transaction(async (transaction) => {
      const snapshot = await transaction.snapshot.upsert({
        where: { key },
        update: data,
        create: { key, ...data },
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
    // Resolve targets before the transaction: reciprocal relations must not
    // hold writes on each other's anime while inserting their foreign keys.
    const targets = await Promise.all(
      relations.map((relation) => this.upsertAnime(relation.anime)),
    );
    const replace = async (tx: Prisma.TransactionClient) => {
      // Serialize replacements even when the source has no existing edges.
      // An advisory lock avoids blocking foreign keys from other anime.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`animehub:relations:${animeId}`}, 0))
      `;
      await tx.animeRelation.deleteMany({
        where: { sourceAnimeId: animeId },
      });
      for (const [position, relation] of relations.entries()) {
        await tx.animeRelation.create({
          data: {
            sourceAnimeId: animeId,
            targetAnimeId: targets[position].id,
            targetSourceId: relation.anime.id,
            targetSlug: relation.anime.slug,
            targetTitle: relation.anime.title,
            targetPosterUrl: relation.anime.posterUrl,
            targetYear: relation.anime.startDate?.getUTCFullYear(),
            kind: relation.kind,
            position,
          },
        });
      }
    };
    // A concurrent multi-anime writer (home refresh) can still deadlock with
    // these foreign keys. Retry only transactions PostgreSQL has rolled back.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(replace);
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2034' ||
          attempt === 3
        ) {
          throw error;
        }
      }
    }
  }
}
