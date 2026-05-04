-- W.10 — persist collapsed group keys with the bulk-ops template so
-- the user's preferred density survives across sessions / browsers.

BEGIN;

ALTER TABLE "BulkOpsTemplate"
  ADD COLUMN IF NOT EXISTS "collapsedGroups" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMIT;
