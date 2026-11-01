-- The catalog listing is served from "Anime": only search pages remain
-- cached as CATALOG snapshots, and they are rebuilt on their first request.
DELETE FROM "Snapshot" WHERE "kind" = 'CATALOG';

-- "Título A–Z": Spanish alphabetical order, word by word ("Uchi no…" before
-- "Uchiage…"), accents and case aside, numbers by value. Leading signs are
-- stripped by the query, not here.
CREATE COLLATION "title_order" (provider = icu, locale = 'es-u-kn');
