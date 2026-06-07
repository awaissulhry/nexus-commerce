-- BL — blended multi-placement "lanes" + base-bid directive on RankTarget.
-- When `lanes` is set, the rank engine drives Top + Rest of Search + Product pages
-- simultaneously in one combined placement write (instead of the single `placement`,
-- which zeros the other search placement). `bidMode`/`bidValueCents`/`bidDeltaPct` add a
-- base-bid lever the placement multipliers stack on. All additive + nullable, so every
-- existing single-placement target keeps EXACTLY today's behaviour until tuned.
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "lanes" JSONB;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "bidMode" TEXT;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "bidValueCents" INTEGER;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "bidDeltaPct" INTEGER;
