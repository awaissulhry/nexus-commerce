-- L.15.0 — Saved-search filter sets for /sync-logs.
--
-- Operators triaging recurring incidents pin their useful filter
-- combinations ("Amazon throttling last 24h", "Failed eBay orders
-- this week", etc.) and re-apply with one click rather than
-- rebuilding from chips.

CREATE TABLE IF NOT EXISTS "SyncLogSavedSearch" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "surface"   TEXT NOT NULL,
  "filters"   JSONB NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncLogSavedSearch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SyncLogSavedSearch_surface_name_idx"
  ON "SyncLogSavedSearch"("surface", "name");
