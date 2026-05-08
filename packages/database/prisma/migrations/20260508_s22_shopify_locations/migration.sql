-- S.22 — Shopify Locations multi-location binding (schema only).
--
-- StockLocation gains:
--   externalLocationId — the channel-side ID of the location.
--                        Shopify Location ID (e.g. 'gid://shopify/
--                        Location/123' or numeric), Amazon FC code,
--                        etc. Disambiguated by externalChannel.
--   externalChannel    — the channel that owns the externalLocationId.
--                        Today: 'SHOPIFY' for SHOPIFY_LOCATION rows,
--                        'AMAZON' for AMAZON_FBA pools (operator can
--                        backfill the AMAZON-EU-FBA row's marketplace
--                        ID later).
--
-- New StockLocation.type value: 'SHOPIFY_LOCATION'. The TEXT column
-- already accepts arbitrary values — no enum migration needed.
--
-- Idempotency: IF NOT EXISTS guards mean re-running is safe.

ALTER TABLE "StockLocation"
  ADD COLUMN IF NOT EXISTS "externalLocationId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalChannel" TEXT;

CREATE INDEX IF NOT EXISTS "StockLocation_externalChannel_externalLocationId_idx"
  ON "StockLocation"("externalChannel", "externalLocationId");

-- Unique constraint: one Nexus StockLocation per (externalChannel,
-- externalLocationId) — prevents accidental duplicate mappings if the
-- discover-cron runs twice. NULL pairs are allowed (warehouses don't
-- have an external mapping).
CREATE UNIQUE INDEX IF NOT EXISTS
  "StockLocation_externalChannel_externalLocationId_unique_idx"
  ON "StockLocation"("externalChannel", "externalLocationId")
  WHERE "externalChannel" IS NOT NULL AND "externalLocationId" IS NOT NULL;
