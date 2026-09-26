-- Progress columns (docs/product-sheet-views/PLAN-2026-09-26.md) — the optional side of each readiness row.
-- Additive only: three nullable columns. Existing rows read NULL = not recorded yet, which is what they are;
-- the nightly readiness refresh (or the family's next edit) fills them. IF NOT EXISTS keeps a re-run harmless
-- on a database where the file was applied directly.
ALTER TABLE "ReadinessIndex" ADD COLUMN IF NOT EXISTS "optionalFilled" INTEGER;
ALTER TABLE "ReadinessIndex" ADD COLUMN IF NOT EXISTS "optionalTotal" INTEGER;
ALTER TABLE "ReadinessIndex" ADD COLUMN IF NOT EXISTS "optionalMissing" JSONB;
