-- APS.5b — named, reusable product selections for the campaign builders.
--
-- Additive: one new table, nothing existing is touched.
--
-- Why not reuse SavedView: that model stores FILTERS (a query re-evaluated on
-- read, translated by build-where.service.ts) and carries a SavedViewAlert
-- relation. A product set is an explicit curated LIST. Sharing one table would
-- force one of the two to misrepresent what it holds.
--
-- Scoped to (channel, marketplace) because a set curated for Italy is not valid
-- for Germany — the advertisable catalogue differs per market, which is the
-- premise of the whole APS series. Loading re-resolves ids against the CURRENT
-- scope so anything that has fallen out is reported rather than silently staged.

CREATE TABLE IF NOT EXISTS "AdProductSet" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "channel"     TEXT NOT NULL DEFAULT 'AMAZON',
  "marketplace" TEXT NOT NULL,
  "productIds"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdProductSet_pkey" PRIMARY KEY ("id")
);

-- One name per market: "GALE launch set" means one thing on IT and may mean a
-- different list on DE, but never two different lists on the same market.
CREATE UNIQUE INDEX IF NOT EXISTS "AdProductSet_channel_marketplace_name_key"
  ON "AdProductSet" ("channel", "marketplace", "name");

CREATE INDEX IF NOT EXISTS "AdProductSet_channel_marketplace_idx"
  ON "AdProductSet" ("channel", "marketplace");
