import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { SITEMAP_MAX_ANIME, SitemapService } from './sitemap.service';

describe('SitemapService', () => {
  it('lists available anime by slug with their last content change', async () => {
    const findMany = vi.fn(() =>
      Promise.resolve([
        {
          slug: 'naruto',
          contentUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
          latestEpisodePublishedAt: null,
        },
        {
          slug: 'one-piece',
          contentUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
          latestEpisodePublishedAt: new Date('2026-10-05T12:00:00.000Z'),
        },
        {
          slug: 'x1999',
          contentUpdatedAt: new Date('2026-03-01T00:00:00.000Z'),
          latestEpisodePublishedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      ]),
    );
    const service = new SitemapService({
      anime: { findMany },
    } as unknown as PrismaService);

    await expect(service.getAnime()).resolves.toEqual({
      data: [
        { slug: 'naruto', updatedAt: '2026-01-01T00:00:00.000Z' },
        { slug: 'one-piece', updatedAt: '2026-10-05T12:00:00.000Z' },
        { slug: 'x1999', updatedAt: '2026-03-01T00:00:00.000Z' },
      ],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { availability: 'AVAILABLE' },
        orderBy: { slug: 'asc' },
        take: SITEMAP_MAX_ANIME,
      }),
    );
    expect(SITEMAP_MAX_ANIME).toBe(50_000);
  });
});
