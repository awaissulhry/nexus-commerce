-- MP — rank-target motion profile: HOW the loop moves the bias (jump / climb / ease / ceiling).
-- All additive; every column is nullable or defaults to false, so existing targets keep
-- exactly today's behaviour until an operator tunes them.
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "jumpStartPct" INTEGER;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "stepUpPct" INTEGER;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "stepDownPct" INTEGER;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "maxBiasPct" INTEGER;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "keepClimbing" BOOLEAN NOT NULL DEFAULT false;
