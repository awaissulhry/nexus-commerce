-- Catch-up migration for schema fields that landed in the parallel R-series
-- commits (R.2.2 inspection artifacts, R.3.2 disposition routing, warehouse
-- kind for return-routing) without their corresponding migrations. The
-- schema declarations are already authoritative on main; this brings the
-- migration tree back into agreement so `prisma migrate deploy` succeeds.
--
-- All five columns are pure-additive nullables (or array/jsonb with safe
-- defaults). No backfill required — existing rows behave the same as
-- before because every new column is nullable / defaults to empty.

-- Warehouse.kind — used by R.3.2 to route restock items by disposition.
-- Values: PRIMARY | SECOND_QUALITY | REFURBISH | QUARANTINE.
ALTER TABLE "Warehouse"
  ADD COLUMN IF NOT EXISTS "kind" TEXT;

-- ReturnItem inspection artifacts (R.2.2) — Cloudinary photo URLs the
-- operator captured during the inspect step + structured checklist
-- answers persisted as JSONB so the shape can iterate without
-- migrations.
ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "photoUrls" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "inspectionChecklist" JSONB;

-- ReturnItem disposition (R.3.2) — set during inspect, consumed by
-- restock to route the item to the matching warehouse pool.
-- Values: SELLABLE | SECOND_QUALITY | REFURBISH | QUARANTINE | SCRAP.
ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "disposition" TEXT;
-- Free-text "why was this item scrapped" recorded only when
-- disposition=SCRAP. Nullable so the inspect step doesn't force a
-- value when scrapping isn't selected.
ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "scrapReason" TEXT;
