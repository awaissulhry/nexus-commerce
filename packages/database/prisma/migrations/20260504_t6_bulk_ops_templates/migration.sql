-- T.6 — server-side bulk-ops templates. Replaces the localStorage-only
-- saved-views the bulk-ops grid shipped with so configurations can
-- survive across browsers and be shared with teammates.

BEGIN;

CREATE TABLE IF NOT EXISTS "BulkOpsTemplate" (
  "id"                  TEXT PRIMARY KEY,
  "name"                TEXT      NOT NULL,
  "description"         TEXT,
  "userId"              TEXT,
  "columnIds"           TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],
  "filterState"         JSONB,
  "enabledChannels"     TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],
  "enabledProductTypes" TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "BulkOpsTemplate_userId_idx"
  ON "BulkOpsTemplate" ("userId");

CREATE INDEX IF NOT EXISTS "BulkOpsTemplate_updatedAt_idx"
  ON "BulkOpsTemplate" ("updatedAt");

COMMIT;
