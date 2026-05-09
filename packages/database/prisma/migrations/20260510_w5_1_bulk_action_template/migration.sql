-- W5.1 — BulkActionTemplate: reusable bulk-action templates
--
-- Distinct from BulkOpsTemplate (grid VIEWS). Captures a bulk
-- operation operators want to re-run with parameters: "+5%
-- pricing on Amazon IT", "translate to Italian", etc.

CREATE TABLE "BulkActionTemplate" (
  "id"             TEXT PRIMARY KEY,

  "name"           TEXT NOT NULL,
  "description"    TEXT,

  "actionType"     TEXT NOT NULL,
  "channel"        TEXT,

  "actionPayload"  JSONB NOT NULL DEFAULT '{}'::jsonb,
  "defaultFilters" JSONB,
  "parameters"     JSONB NOT NULL DEFAULT '[]'::jsonb,

  "category"       TEXT,
  "userId"         TEXT,
  "isBuiltin"      BOOLEAN NOT NULL DEFAULT false,

  "usageCount"     INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt"     TIMESTAMP(3),

  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

CREATE INDEX "BulkActionTemplate_userId_idx"     ON "BulkActionTemplate"("userId");
CREATE INDEX "BulkActionTemplate_category_idx"   ON "BulkActionTemplate"("category");
CREATE INDEX "BulkActionTemplate_actionType_idx" ON "BulkActionTemplate"("actionType");
CREATE INDEX "BulkActionTemplate_usageCount_idx" ON "BulkActionTemplate"("usageCount" DESC);
