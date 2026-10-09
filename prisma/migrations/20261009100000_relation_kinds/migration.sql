-- AnimeAV1 distinguishes these relation codes; they were previously folded
-- into ALTERNATIVE (3), MAIN_STORY (7) and OTHER (9). Existing rows keep their
-- old kind until the anime's detail is refreshed from the source.
ALTER TYPE "RelationKind" ADD VALUE 'ALTERNATIVE_SETTING';
ALTER TYPE "RelationKind" ADD VALUE 'FULL_STORY';
ALTER TYPE "RelationKind" ADD VALUE 'SPIN_OFF';
