UPDATE "Episode" AS episode
SET "imageUrl" = CONCAT(
  'https://cdn.animeav1.com/screenshots/',
  anime."sourceId",
  '/',
  CASE
    WHEN episode."number" = TRUNC(episode."number")
      THEN TRUNC(episode."number")::text
    ELSE episode."number"::text
  END,
  '.jpg'
)
FROM "Anime" AS anime
WHERE episode."animeId" = anime."id"
  AND episode."imageUrl" IS NULL;
