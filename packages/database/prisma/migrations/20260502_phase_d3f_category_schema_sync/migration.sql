-- Phase D.3f: live category schema sync
--
-- Two new tables:
--   CategorySchema — cached snapshots of getDefinitionsProductType
--   SchemaChange   — append-only log of detected diffs
--
-- All statements idempotent so re-runs are safe.

CREATE TABLE IF NOT EXISTS "CategorySchema" (
  "id"               TEXT PRIMARY KEY,
  "channel"          TEXT NOT NULL,
  "marketplace"      TEXT,
  "productType"      TEXT NOT NULL,
  "schemaVersion"    TEXT NOT NULL,
  "schemaDefinition" JSONB NOT NULL,
  "variationThemes"  JSONB,
  "fetchedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"        TIMESTAMP(3) NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT TRUE
);

-- Postgres treats NULL marketplace values as distinct in unique
-- indexes — that's the desired behaviour for channels like eBay
-- where marketplace may be unset.
CREATE UNIQUE INDEX IF NOT EXISTS "CategorySchema_channel_marketplace_productType_schemaVersion_key"
  ON "CategorySchema" ("channel", "marketplace", "productType", "schemaVersion");

CREATE INDEX IF NOT EXISTS "CategorySchema_channel_marketplace_productType_idx"
  ON "CategorySchema" ("channel", "marketplace", "productType");

CREATE INDEX IF NOT EXISTS "CategorySchema_expiresAt_idx"
  ON "CategorySchema" ("expiresAt");

CREATE TABLE IF NOT EXISTS "SchemaChange" (
  "id"               TEXT PRIMARY KEY,
  "channel"          TEXT NOT NULL,
  "marketplace"      TEXT,
  "productType"      TEXT NOT NULL,
  "changeType"       TEXT NOT NULL,
  "fieldId"          TEXT NOT NULL,
  "oldValue"         JSONB,
  "newValue"         JSONB,
  "detectedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "affectedProducts" TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS "SchemaChange_channel_marketplace_productType_idx"
  ON "SchemaChange" ("channel", "marketplace", "productType");

CREATE INDEX IF NOT EXISTS "SchemaChange_detectedAt_idx"
  ON "SchemaChange" ("detectedAt");
