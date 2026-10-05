import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '../generated/prisma/client';
import { SnapshotKind } from '../generated/prisma/enums';
import { createPrismaAdapter } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import type { SourceHome, SourceAnimeDetail } from '../source/source.types';
import {
  HOME_FULL_REFRESH_INTERVAL_MS,
  HOME_LEASE_MS,
  HOME_READ_TIMEOUT_MS,
  HOME_RECENT_REFRESH_INTERVAL_MS,
  homeBackoffMs,
  type HomeRefreshMode,
} from './home-policy';

export const HOME_SNAPSHOT_KINDS = [
  SnapshotKind.HOME_FEATURED,
  SnapshotKind.HOME_RECENT_EPISODES,
  SnapshotKind.HOME_RECENT_ANIME,
] as const;
export const HOME_LEASE_KEY = 'home';
export interface HomeLease {
  token: string;
  failures: number;
}
export class HomeLeaseLostError extends Error {}

@Injectable()
export class HomeStore implements OnModuleDestroy {
  private readonly client: PrismaClient;
  constructor(
    config: ConfigService,
    private readonly projection: ProjectionService,
  ) {
    this.client = new PrismaClient({
      adapter: createPrismaAdapter(config, {
        max: 3,
        connectionTimeoutMillis: 500,
        query_timeout: 1_500,
        statement_timeout: 1_500,
        idleTimeoutMillis: 10_000,
      }),
    });
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }

  // Repeatable read spans Prisma's relation queries. A reader sees one complete
  // published generation, including its anime/episode data and freshness.
  read() {
    return this.transaction(
      (tx) =>
        tx.snapshot.findMany({
          where: { kind: { in: [...HOME_SNAPSHOT_KINDS] } },
          include: {
            items: {
              orderBy: { position: 'asc' as const },
              include: {
                anime: {
                  include: {
                    category: true,
                    genres: { include: { genre: true } },
                  },
                },
                episode: true,
              },
            },
          },
        }),
      HOME_READ_TIMEOUT_MS,
      Prisma.TransactionIsolationLevel.RepeatableRead,
    );
  }

  acquire(): Promise<HomeLease | null> {
    return this.transaction(async (tx) => {
      const now = await this.databaseNow(tx);
      await tx.homeRefreshLease.createMany({
        data: [{ key: HOME_LEASE_KEY, expiresAt: now, nextAttemptAt: now }],
        skipDuplicates: true,
      });
      const token = randomUUID();
      const result = await tx.homeRefreshLease.updateMany({
        where: {
          key: HOME_LEASE_KEY,
          expiresAt: { lte: now },
          nextAttemptAt: { lte: now },
        },
        data: { token, expiresAt: new Date(now.getTime() + HOME_LEASE_MS) },
      });
      if (!result.count) return null;
      const state = await tx.homeRefreshLease.findUniqueOrThrow({
        where: { key: HOME_LEASE_KEY },
      });
      return { token, failures: state.failures };
    });
  }

  async release(
    lease: HomeLease,
    failed: boolean,
    budget = HOME_READ_TIMEOUT_MS,
  ) {
    await this.transaction(async (tx) => {
      const now = await this.databaseNow(tx);
      const failures = failed ? lease.failures + 1 : 0;
      await tx.homeRefreshLease.updateMany({
        where: { key: HOME_LEASE_KEY, token: lease.token },
        data: {
          token: null,
          expiresAt: now,
          failures,
          nextAttemptAt: new Date(
            now.getTime() + (failed ? homeBackoffMs(failures) : 0),
          ),
        },
      });
    }, budget);
  }

  // The lease row is locked throughout projection + publication. A expired
  // owner's token can never replace a newer owner's snapshots. Any abort or
  // failed section write rolls back both projected records and all snapshots.
  publish(
    home: SourceHome,
    mode: HomeRefreshMode,
    lease: HomeLease,
    signal: AbortSignal,
    deadline: number,
    release = true,
  ) {
    signal.throwIfAborted();
    return this.transaction(
      async (tx) => {
        signal.throwIfAborted();
        const now = await this.databaseNow(tx);
        const owned = await tx.homeRefreshLease.updateMany({
          where: {
            key: HOME_LEASE_KEY,
            token: lease.token,
            expiresAt: { gt: now },
          },
          data: { token: lease.token },
        });
        if (!owned.count) throw new HomeLeaseLostError();
        const fetchedAt = now;
        let published = 0;
        const write = async (
          key: string,
          kind: SnapshotKind,
          entries: { animeId: string; episodeId?: string }[],
          ttl: number,
        ) => {
          if (!entries.length) return;
          signal.throwIfAborted();
          const snapshot = await tx.snapshot.upsert({
            where: { key },
            update: {
              kind,
              fetchedAt,
              nextRefreshAt: new Date(fetchedAt.getTime() + ttl),
            },
            create: {
              key,
              kind,
              fetchedAt,
              nextRefreshAt: new Date(fetchedAt.getTime() + ttl),
            },
          });
          await tx.snapshotItem.deleteMany({
            where: { snapshotId: snapshot.id },
          });
          await tx.snapshotItem.createMany({
            data: entries.map((entry, position) => ({
              ...entry,
              snapshotId: snapshot.id,
              position,
            })),
          });
          published++;
        };
        if (mode === 'full') {
          for (const [key, kind, items] of [
            ['home:featured', SnapshotKind.HOME_FEATURED, home.featured],
            [
              'home:recent-anime',
              SnapshotKind.HOME_RECENT_ANIME,
              home.recentAnime,
            ],
          ] as const) {
            const entries: { animeId: string }[] = [];
            for (const item of items) {
              signal.throwIfAborted();
              const anime = await this.projection.upsertAnime(item, tx);
              entries.push({ animeId: anime.id });
            }
            await write(key, kind, entries, HOME_FULL_REFRESH_INTERVAL_MS);
          }
        }
        const episodes: { animeId: string; episodeId: string }[] = [];
        for (const item of home.recentEpisodes) {
          signal.throwIfAborted();
          const anime = await this.projection.upsertAnime(item.anime, tx);
          const episode = await this.projection.upsertEpisode(
            anime.id,
            item.episode,
            tx,
          );
          if (item.episode.publishedAt) {
            await tx.anime.updateMany({
              where: {
                id: anime.id,
                OR: [
                  { latestEpisodePublishedAt: null },
                  {
                    latestEpisodePublishedAt: { lt: item.episode.publishedAt },
                  },
                ],
              },
              data: { latestEpisodePublishedAt: item.episode.publishedAt },
            });
          }
          episodes.push({ animeId: anime.id, episodeId: episode.id });
        }
        await write(
          'home:recent-episodes',
          SnapshotKind.HOME_RECENT_EPISODES,
          episodes,
          HOME_RECENT_REFRESH_INTERVAL_MS,
        );
        signal.throwIfAborted();
        const finishedAt = await this.databaseNow(tx);
        const failures =
          published === (mode === 'full' ? 3 : 1) ? 0 : lease.failures + 1;
        const released = await tx.homeRefreshLease.updateMany({
          where: {
            key: HOME_LEASE_KEY,
            token: lease.token,
            expiresAt: { gt: finishedAt },
          },
          data: {
            token: release ? null : lease.token,
            expiresAt: release ? finishedAt : undefined,
            failures,
            nextAttemptAt: new Date(
              finishedAt.getTime() + (failures ? homeBackoffMs(failures) : 0),
            ),
          },
        });
        if (!released.count) throw new HomeLeaseLostError();
        signal.throwIfAborted();
        return { published, partial: failures > 0 };
      },
      Math.max(1, deadline - Date.now()),
    );
  }

  enrichDetail(
    detail: SourceAnimeDetail,
    lease: HomeLease,
    signal: AbortSignal,
    deadline: number,
  ) {
    signal.throwIfAborted();
    return this.transaction(
      async (tx) => {
        const now = await this.databaseNow(tx);
        const owned = await tx.homeRefreshLease.updateMany({
          where: {
            key: HOME_LEASE_KEY,
            token: lease.token,
            expiresAt: { gt: now },
          },
          data: { token: lease.token },
        });
        if (!owned.count) throw new HomeLeaseLostError();
        signal.throwIfAborted();
        const anime = await this.projection.upsertAnime(detail, tx);
        await tx.anime.update({
          where: { id: anime.id },
          data: {
            episodeCount: detail.episodeCount ?? undefined,
            trailerUrl: detail.trailerUrl ?? undefined,
          },
        });
        signal.throwIfAborted();
      },
      Math.max(1, deadline - Date.now()),
    );
  }

  private async databaseNow(tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }

  private transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    budget = HOME_READ_TIMEOUT_MS,
    isolationLevel: Prisma.TransactionIsolationLevel = Prisma
      .TransactionIsolationLevel.ReadCommitted,
  ) {
    return this.client.$transaction(fn, {
      maxWait: Math.min(500, budget),
      timeout: Math.max(1, budget - 500),
      isolationLevel,
    });
  }
}

export type HomeSnapshots = Awaited<ReturnType<HomeStore['read']>>;
