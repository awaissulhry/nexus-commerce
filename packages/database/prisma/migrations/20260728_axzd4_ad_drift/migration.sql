-- AX-ZD.4 — drift detection. Additive: one new table, nothing altered.
CREATE TABLE IF NOT EXISTS "AdDrift" (
  "id"              TEXT PRIMARY KEY,
  "entityType"      TEXT NOT NULL,
  "entityId"        TEXT NOT NULL,
  "externalId"      TEXT,
  "marketplace"     TEXT,
  "entityName"      TEXT,
  "field"           TEXT NOT NULL,
  "ourValue"        TEXT,
  "amazonValue"     TEXT,
  "classification"  TEXT NOT NULL,
  "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDetectedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "occurrences"     INTEGER NOT NULL DEFAULT 1,
  "resolvedAt"      TIMESTAMP(3)
);

-- One open record per entity+field: a campaign drifting for three days is ONE
-- row with a high occurrence count, not one row per sync tick.
CREATE UNIQUE INDEX IF NOT EXISTS "AdDrift_entityType_entityId_field_key"
  ON "AdDrift"("entityType", "entityId", "field");
CREATE INDEX IF NOT EXISTS "AdDrift_classification_lastDetectedAt_idx"
  ON "AdDrift"("classification", "lastDetectedAt" DESC);
CREATE INDEX IF NOT EXISTS "AdDrift_resolvedAt_lastDetectedAt_idx"
  ON "AdDrift"("resolvedAt", "lastDetectedAt" DESC);
CREATE INDEX IF NOT EXISTS "AdDrift_entityType_entityId_idx"
  ON "AdDrift"("entityType", "entityId");
