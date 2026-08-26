import { vi } from 'vitest';
import { SnapshotKind } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from './projection.service';

interface SnapshotState {
  id: string;
  key: string;
  kind: SnapshotKind;
  fetchedAt: Date;
  nextRefreshAt: Date;
  totalPages?: number;
  totalRecords?: number;
  minYear?: number;
  maxYear?: number;
}

interface SnapshotItemState {
  snapshotId: string;
  animeId: string;
  episodeId?: string;
  label?: string;
  position: number;
}

interface SnapshotUpsertInput {
  where: { key: string };
  update: Omit<SnapshotState, 'id' | 'key'>;
  create: Omit<SnapshotState, 'id'>;
}

interface SnapshotItemsInput {
  data: SnapshotItemState[];
}

interface FakeTransaction {
  snapshot: {
    upsert(input: SnapshotUpsertInput): Promise<SnapshotState>;
  };
  snapshotItem: {
    deleteMany(): Promise<{ count: number }>;
    createMany(input: SnapshotItemsInput): Promise<{ count: number }>;
  };
}

function cloneState(state: {
  snapshot: SnapshotState;
  items: SnapshotItemState[];
}) {
  return {
    snapshot: {
      ...state.snapshot,
      fetchedAt: new Date(state.snapshot.fetchedAt),
      nextRefreshAt: new Date(state.snapshot.nextRefreshAt),
    },
    items: state.items.map((item) => ({ ...item })),
  };
}

function createHarness() {
  let committed: {
    snapshot: SnapshotState;
    items: SnapshotItemState[];
  } = {
    snapshot: {
      id: 'snapshot-id',
      key: 'home:recent-episodes',
      kind: SnapshotKind.HOME_RECENT_EPISODES,
      fetchedAt: new Date('2026-08-26T17:00:00.000Z'),
      nextRefreshAt: new Date('2026-08-26T17:04:00.000Z'),
      totalPages: undefined,
      totalRecords: undefined,
    },
    items: [
      {
        snapshotId: 'snapshot-id',
        animeId: 'old-anime',
        episodeId: 'old-episode',
        position: 0,
      },
    ],
  };
  let failCreateMany = false;

  const transaction = vi.fn(
    async (callback: (tx: FakeTransaction) => Promise<unknown>) => {
      const draft = cloneState(committed);
      const tx: FakeTransaction = {
        snapshot: {
          upsert: vi.fn((input: SnapshotUpsertInput) => {
            draft.snapshot = {
              id: draft.snapshot.id,
              key: input.where.key,
              ...input.update,
            };
            return Promise.resolve(draft.snapshot);
          }),
        },
        snapshotItem: {
          deleteMany: vi.fn(() => {
            const count = draft.items.length;
            draft.items = [];
            return Promise.resolve({ count });
          }),
          createMany: vi.fn((input: SnapshotItemsInput) => {
            if (failCreateMany) {
              return Promise.reject(new Error('createMany failed'));
            }
            draft.items = input.data.map((item) => ({ ...item }));
            return Promise.resolve({ count: draft.items.length });
          }),
        },
      };
      const result = await callback(tx);
      committed = draft;
      return result;
    },
  );
  const prisma = { $transaction: transaction };
  const service = new ProjectionService(prisma as unknown as PrismaService);
  return {
    service,
    transaction,
    getCommitted: () => cloneState(committed),
    failNextCreateMany: () => {
      failCreateMany = true;
    },
  };
}

describe('ProjectionService.replaceSnapshot', () => {
  it('publishes freshness metadata and replacement content atomically', async () => {
    const { service, transaction, getCommitted } = createHarness();
    const fetchedAt = new Date('2026-08-26T18:30:00.000Z');

    await service.replaceSnapshot(
      'home:recent-episodes',
      SnapshotKind.HOME_RECENT_EPISODES,
      [
        { animeId: 'new-anime', episodeId: 'episode-8' },
        { animeId: 'other-anime', episodeId: 'episode-10' },
      ],
      { ttlMinutes: 4, fetchedAt, minYear: 1990, maxYear: 2026 },
    );

    const state = getCommitted();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(state.snapshot.fetchedAt).toEqual(fetchedAt);
    expect(state.snapshot.nextRefreshAt).toEqual(
      new Date('2026-08-26T18:34:00.000Z'),
    );
    expect(state.snapshot.minYear).toBe(1990);
    expect(state.snapshot.maxYear).toBe(2026);
    expect(state.items).toEqual([
      {
        snapshotId: 'snapshot-id',
        animeId: 'new-anime',
        episodeId: 'episode-8',
        label: undefined,
        position: 0,
      },
      {
        snapshotId: 'snapshot-id',
        animeId: 'other-anime',
        episodeId: 'episode-10',
        label: undefined,
        position: 1,
      },
    ]);
  });

  it('rolls metadata and content back together when item creation fails', async () => {
    const { service, getCommitted, failNextCreateMany } = createHarness();
    const before = getCommitted();
    failNextCreateMany();

    await expect(
      service.replaceSnapshot(
        'home:recent-episodes',
        SnapshotKind.HOME_RECENT_EPISODES,
        [{ animeId: 'new-anime', episodeId: 'episode-8' }],
        {
          ttlMinutes: 4,
          fetchedAt: new Date('2026-08-26T18:30:00.000Z'),
        },
      ),
    ).rejects.toThrow('createMany failed');

    expect(getCommitted()).toEqual(before);
  });
});
