-- VT.1b item 4 (VT.4's REQUEST) — the server-side narrowing field for `/products/next?filter=variation-mapping:…`
--
-- ADDITIVE and nullable: no backfill, no default, no index change to an existing column. Pre-approved as a shape
-- (feedback_additive_migrations_preapproved) but NOT YET APPLIED ANYWHERE, and deliberately NOT in
-- packages/database/prisma/migrations/ — an unapplied folder there is applied by the next sibling's `migrate deploy`
-- (the 2026-09-01 drag, hub ruling #12). Move it in at apply time.
--
-- Values: 'derived' | 'rule' | 'override' | 'unset' | 'collides' (VX §11.4 / R-VT-5's words). NULL = not computed,
-- which is what every existing row carries until the producer stamps it — and "not computed" must never read as
-- "derived" (R-LX-9's own lesson, one table over).
ALTER TABLE "ReadinessIndex" ADD COLUMN IF NOT EXISTS "variationSource" TEXT;

-- The filter narrows on (coordinate, variationSource); the existing coordinate index carries the left-hand side, so
-- this partial index is the whole cost and it only covers rows the filter can match.
CREATE INDEX IF NOT EXISTS "ReadinessIndex_variationSource_idx"
  ON "ReadinessIndex" ("variationSource")
  WHERE "variationSource" IS NOT NULL;
