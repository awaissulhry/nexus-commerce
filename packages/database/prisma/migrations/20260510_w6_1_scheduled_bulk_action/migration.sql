-- W6.1 — ScheduledBulkAction: one-time + recurring bulk-action schedules
--
-- Operators can fire a bulk operation at a future time or on a cron
-- cadence. Each fire creates a real BulkActionJob via
-- BulkActionService.createJob. Pause / resume = nullify / recompute
-- nextRunAt. enabled stays the operator-facing toggle.

CREATE TABLE "ScheduledBulkAction" (
  "id"                 TEXT PRIMARY KEY,

  "name"               TEXT NOT NULL,
  "description"        TEXT,

  "actionType"         TEXT NOT NULL,
  "channel"            TEXT,

  "actionPayload"      JSONB NOT NULL DEFAULT '{}'::jsonb,

  "targetProductIds"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "targetVariationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "filters"            JSONB,

  "scheduledFor"       TIMESTAMP(3),
  "cronExpression"     TEXT,
  "timezone"           TEXT NOT NULL DEFAULT 'Europe/Rome',

  "nextRunAt"          TIMESTAMP(3),
  "enabled"            BOOLEAN NOT NULL DEFAULT true,

  "lastRunAt"          TIMESTAMP(3),
  "lastJobId"          TEXT,
  "lastStatus"         TEXT,
  "lastError"          TEXT,
  "runCount"           INTEGER NOT NULL DEFAULT 0,

  "templateId"         TEXT,

  "createdBy"          TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL
);

CREATE INDEX "ScheduledBulkAction_enabled_nextRunAt_idx"
  ON "ScheduledBulkAction"("enabled", "nextRunAt");
CREATE INDEX "ScheduledBulkAction_actionType_idx"
  ON "ScheduledBulkAction"("actionType");
CREATE INDEX "ScheduledBulkAction_templateId_idx"
  ON "ScheduledBulkAction"("templateId");
