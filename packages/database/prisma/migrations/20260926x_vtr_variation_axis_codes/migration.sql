-- VTR step 1a (docs/variation-theme/STEP1-PLAN.md) — the family's axes as dictionary attribute codes, and a per-family value order.
-- Additive only: two columns, no data written. Existing rows read [] and NULL = "not yet moved to the dictionary"; the backfill
-- (step 1b) fills them only after the Owner reads its report.
ALTER TABLE "Product" ADD COLUMN "variationAxisCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Product" ADD COLUMN "variationValueOrder" JSONB;
