// AnimeAV1's /catalogo serves fixed pages of 20 records and never more than 50
// pages per query. Its pagination clamps the advertised totals instead of
// reporting the real match count: a broad query reports exactly 1000 records /
// 50 pages, and page 51+ is empty, however many titles actually match (verified
// against /catalogo/__data.json: unfiltered → 1000/50, minYear=2024 → 731/37).
export const ANIMEAV1_CATALOG_PAGE_SIZE = 20;
export const ANIMEAV1_CATALOG_MAX_PAGES = 50;
export const ANIMEAV1_CATALOG_MAX_RECORDS =
  ANIMEAV1_CATALOG_PAGE_SIZE * ANIMEAV1_CATALOG_MAX_PAGES;

/**
 * Whether the source truncated a catalog result set at its maximum. A query
 * that matches exactly 1000 titles is indistinguishable from a truncated one,
 * so `true` means "at least this many".
 */
export function isCatalogCapped(totalRecords: number | null | undefined) {
  return (totalRecords ?? 0) >= ANIMEAV1_CATALOG_MAX_RECORDS;
}
