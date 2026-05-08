-- S.16 — ABC classification persisted on Product.
--
-- Two columns + one index. Materialized via a weekly cron
-- (abc-classification.job) so reads are O(1) — no aggregate scan
-- on the hot stock-list path.
--
-- abcClass values: 'A' | 'B' | 'C' | 'D' | NULL.
--   A — top 80% of cumulative metric (revenue by default)
--   B — next 15% (≤ 95% cumulative)
--   C — remaining sales-active items
--   D — zero sales in the window (separated so reports can
--       distinguish "low contribution" from "no contribution")
--   NULL — never classified yet
--
-- The TEXT column is intentionally not an enum: we may add E/F
-- (per-channel splits) later without a migration.

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "abcClass" TEXT,
  ADD COLUMN IF NOT EXISTS "abcClassUpdatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Product_abcClass_idx" ON "Product"("abcClass");
