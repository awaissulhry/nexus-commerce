-- =====================================================================
-- H.8: Saved-view alerts + in-app notifications
--
-- Two new tables:
--
-- 1. Notification — generic per-user inbox row. Today written by the
--    saved-view alerts evaluator; future surfaces (sync failures,
--    low-stock thresholds, AI-job completion) will land in the same
--    table so the topnav bell renders one feed.
--
-- 2. SavedViewAlert — hangs off SavedView. The cron job (every 5 min)
--    re-evaluates each active row's saved-view filter, counts the
--    matching products, compares to threshold, and fires a Notification
--    if the condition is met and the cooldown has elapsed.
--
-- Both tables are append-only from the cron's perspective; only the
-- mark-read endpoint and operator UI mutate existing rows.
-- =====================================================================

-- 1. Notification
CREATE TABLE "Notification" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "type"       TEXT NOT NULL,
  "severity"   TEXT NOT NULL DEFAULT 'info',
  "title"      TEXT NOT NULL,
  "body"       TEXT,
  "entityType" TEXT,
  "entityId"   TEXT,
  "meta"       JSONB,
  "href"       TEXT,
  "readAt"     TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Notification_userId_readAt_idx"
  ON "Notification" ("userId", "readAt");
CREATE INDEX "Notification_userId_createdAt_idx"
  ON "Notification" ("userId", "createdAt");
CREATE INDEX "Notification_type_createdAt_idx"
  ON "Notification" ("type", "createdAt");
CREATE INDEX "Notification_entityType_entityId_idx"
  ON "Notification" ("entityType", "entityId");

-- 2. SavedViewAlert
CREATE TABLE "SavedViewAlert" (
  "id"               TEXT PRIMARY KEY,
  "savedViewId"      TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT TRUE,
  "comparison"       TEXT NOT NULL,
  "threshold"        DECIMAL(14,4) NOT NULL,
  "baselineCount"    INTEGER NOT NULL DEFAULT 0,
  "lastCheckedAt"    TIMESTAMP(3),
  "lastCount"        INTEGER NOT NULL DEFAULT 0,
  "lastFiredAt"      TIMESTAMP(3),
  "cooldownMinutes"  INTEGER NOT NULL DEFAULT 60,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedViewAlert_savedViewId_fkey"
    FOREIGN KEY ("savedViewId") REFERENCES "SavedView" ("id") ON DELETE CASCADE
);

CREATE INDEX "SavedViewAlert_userId_isActive_idx"
  ON "SavedViewAlert" ("userId", "isActive");
CREATE INDEX "SavedViewAlert_savedViewId_idx"
  ON "SavedViewAlert" ("savedViewId");
CREATE INDEX "SavedViewAlert_isActive_lastCheckedAt_idx"
  ON "SavedViewAlert" ("isActive", "lastCheckedAt");
