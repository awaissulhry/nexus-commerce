-- PES.6 wave-4 §1.6(E) — CellFormula carries NO cached value.
--
-- The value layer (the master field / ChannelListing.overrideData) is the only authority. A copy
-- on the formula row drifts the moment anything writes the value without going through the
-- formula path — bulk PATCH, an import, apply-mapping, a publish round-trip — and a stale mirror
-- that only SOMETIMES matches is worse than no mirror.
--
-- DROP COLUMN is destructive in general. Here it is not: "CellFormula" was created by the
-- immediately preceding migration (20260902a) minutes earlier, verified at 0 rows, and nothing
-- reads it yet — the write path is still being built.

ALTER TABLE "CellFormula" DROP COLUMN IF EXISTS "lastValue";

-- When the formula was last evaluated — replaces the cached value as the freshness signal.
ALTER TABLE "CellFormula" ADD COLUMN IF NOT EXISTS "evaluatedAt" TIMESTAMP(3);
