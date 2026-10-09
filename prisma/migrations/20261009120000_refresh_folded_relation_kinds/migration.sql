-- Relations stored before 20261009100000_relation_kinds keep their folded kind
-- (codes 3, 7 and 9 were saved as ALTERNATIVE, MAIN_STORY and OTHER) until the
-- anime's detail is refreshed, and FINISHED anime refresh only every 30 to 180
-- days. Make every anime with such a relation due within the next 24 hours.
-- nextRefreshAt is read lazily: viewing a due anime refreshes it in the
-- background. The random offset spreads the refreshes that a burst of views,
-- such as a crawler walking the sitemap, would otherwise trigger together.
-- LEAST never postpones a refresh that was already due sooner. The column holds
-- UTC without a time zone, so compute in UTC whatever the session time zone.
UPDATE "Anime"
SET "nextRefreshAt" = LEAST(
  "nextRefreshAt",
  (now() AT TIME ZONE 'UTC') + random() * interval '24 hours'
)
WHERE "id" IN (
  SELECT "sourceAnimeId"
  FROM "AnimeRelation"
  WHERE "kind" IN ('ALTERNATIVE', 'MAIN_STORY', 'OTHER')
);
