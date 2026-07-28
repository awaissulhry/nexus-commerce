-- AX2.5 — one row per replication run, so it can be rolled back as a unit.
--
-- Applying a blueprint creates campaigns, ad groups, keywords and product ads.
-- Without a record of what one run produced, undoing it means hunting orphaned
-- entities by name. status/plan/errors also make a PARTIAL run legible: a
-- campaign that landed locally but never got an Amazon id is recorded in
-- notOnAmazon rather than being reported as success. Additive.

CREATE TABLE IF NOT EXISTS "AdBlueprintApplication" (
  "id"                 TEXT PRIMARY KEY,
  "blueprintId"        TEXT NOT NULL,
  "productToken"       TEXT NOT NULL,
  "marketplace"        TEXT NOT NULL,
  "asins"              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"             TEXT NOT NULL DEFAULT 'PLANNED',
  "plan"               JSONB NOT NULL,
  "acceptedConflicts"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "skippedTargets"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdCampaignIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notOnAmazon"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "errors"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "actor"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt"          TIMESTAMP(3),
  "rolledBackAt"       TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "AdBlueprintApplication_blueprintId_idx" ON "AdBlueprintApplication" ("blueprintId");
CREATE INDEX IF NOT EXISTS "AdBlueprintApplication_status_idx" ON "AdBlueprintApplication" ("status");
