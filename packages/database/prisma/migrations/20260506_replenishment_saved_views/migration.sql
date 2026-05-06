-- Replenishment saved views: named filter + sort presets for the
-- /fulfillment/replenishment page. URL-encoded state (R.5) covers
-- the bookmarkable case; these are server-backed for cross-browser
-- persistence + team sharing.

CREATE TABLE IF NOT EXISTS "ReplenishmentSavedView" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "filterState" JSONB NOT NULL,
  "isDefault"   BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdBy"   TEXT
);

CREATE INDEX IF NOT EXISTS "ReplenishmentSavedView_isDefault_idx"
  ON "ReplenishmentSavedView" ("isDefault");
CREATE INDEX IF NOT EXISTS "ReplenishmentSavedView_createdAt_idx"
  ON "ReplenishmentSavedView" ("createdAt" DESC);
