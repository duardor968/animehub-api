import { Prisma } from '../generated/prisma/client';
import { ANIMEAV1_CATALOG_PAGE_SIZE } from '../source/animeav1.constants';
import {
  catalogOrderValues,
  CatalogQueryDto,
  catalogStatusValues,
} from './catalog-query.dto';

type CatalogOrder = (typeof catalogOrderValues)[number];
type CatalogStatus = (typeof catalogStatusValues)[number];

const statusValues: Record<CatalogStatus, string[]> = {
  emision: ['AIRING'],
  finalizado: ['FINISHED'],
  // The source's "Próximamente" covers premieres and series between seasons.
  proximamente: ['UPCOMING', 'PAUSED'],
};

/** Newest first: the source numbers its anime in the order it adds them. */
const latestAdded = Prisma.sql`length(a."sourceId") DESC, a."sourceId" DESC`;

/**
 * The catalog listing over the stored anime: one page of ids in order (pages
 * of the source's size) and the number of matches. `schema` is the quoted schema holding the tables and
 * the title collation (raw SQL is not qualified by the adapter).
 */
export function catalogListing(schema: Prisma.Sql, query: CatalogQueryDto) {
  const table = (name: string) =>
    Prisma.sql`${schema}.${Prisma.raw(`"${name}"`)}`;
  // Leading signs and accents do not count: '"Kimi…"' is under K, '.hack'
  // under H, 'Übel Blatt' under U; a title starting with a digit (or with no
  // letter at all) is under '#'.
  const initial = Prisma.sql`upper(regexp_replace(normalize(substring(a."title" from '[[:alnum:]]'), NFD), '[\\u0300-\\u036f]', '', 'g'))`;
  const conditions = [Prisma.sql`a."availability" = 'AVAILABLE'`];
  const categories = query.category ?? [];
  if (categories.length > 0)
    conditions.push(
      Prisma.sql`a."categoryId" IN (SELECT c."id" FROM ${table('Category')} c WHERE c."slug" IN (${Prisma.join(categories)}))`,
    );
  // Several genres: the anime that have all of them.
  const genres = query.genre ?? [];
  if (genres.length > 0)
    conditions.push(
      Prisma.sql`(SELECT count(*) FROM ${table('AnimeGenre')} ag JOIN ${table('Genre')} g ON g."id" = ag."genreId" WHERE ag."animeId" = a."id" AND g."slug" IN (${Prisma.join(genres)})) = ${genres.length}`,
    );
  if (query.status)
    conditions.push(
      Prisma.sql`a."status"::text IN (${Prisma.join(statusValues[query.status as CatalogStatus])})`,
    );
  if (query.minYear)
    conditions.push(
      Prisma.sql`a."startDate" >= make_timestamp(${query.minYear}::int, 1, 1, 0, 0, 0)`,
    );
  if (query.maxYear)
    conditions.push(
      Prisma.sql`a."startDate" < make_timestamp(${query.maxYear}::int + 1, 1, 1, 0, 0, 0)`,
    );
  const letter = query.letter?.toUpperCase();
  if (letter === '#')
    conditions.push(Prisma.sql`coalesce(${initial} !~ '^[A-Z]$', true)`);
  else if (letter) conditions.push(Prisma.sql`${initial} = ${letter}`);

  const orders: Record<CatalogOrder, Prisma.Sql> = {
    latest_added: latestAdded,
    // Word by word without the leading signs: '#Zombie…' next to 'Zombie…'.
    title: Prisma.sql`regexp_replace(a."title", '^[^[:alnum:]]+', '') COLLATE ${schema}."title_order", ${latestAdded}`,
    popular: Prisma.sql`a."votes" DESC NULLS LAST, ${latestAdded}`,
    score: Prisma.sql`a."score" DESC NULLS LAST, a."votes" DESC NULLS LAST, ${latestAdded}`,
    latest_released: Prisma.sql`a."startDate" DESC NULLS LAST, length(a."sourceId"), a."sourceId"`,
  };
  // Validated by CatalogQueryDto.
  const order = orders[(query.order ?? 'latest_added') as CatalogOrder];

  const from = Prisma.sql`FROM ${table('Anime')} a WHERE ${Prisma.join(conditions, ' AND ')}`;
  const page = query.page ?? 1;
  return {
    page: Prisma.sql`SELECT a."id", count(*) OVER ()::int AS "total" ${from} ORDER BY ${order} LIMIT ${ANIMEAV1_CATALOG_PAGE_SIZE} OFFSET ${(page - 1) * ANIMEAV1_CATALOG_PAGE_SIZE}`,
    count: Prisma.sql`SELECT count(*)::int AS "total" ${from}`,
  };
}
