-- L.16.0 — Alert rule engine (PagerDuty-tier).
--
-- Operators define rules ("error rate > 1% for past 5 minutes")
-- that the evaluator cron checks every minute. When a rule fires,
-- AlertEvent records the trigger; operators ACK or RESOLVE from
-- the UI. Re-firing while still triggered keeps one row, not many.

CREATE TABLE IF NOT EXISTS "AlertRule" (
  "id"                   TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "description"          TEXT,
  "metric"               TEXT NOT NULL,
  "operator"             TEXT NOT NULL,
  "threshold"            DOUBLE PRECISION NOT NULL,
  "windowMinutes"        INTEGER NOT NULL DEFAULT 15,
  "channel"              TEXT,
  "notificationChannels" JSONB NOT NULL,
  "enabled"              BOOLEAN NOT NULL DEFAULT true,
  "lastEvaluatedAt"      TIMESTAMP(3),
  "lastValue"            DOUBLE PRECISION,
  "lastFired"            BOOLEAN NOT NULL DEFAULT false,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AlertRule_enabled_idx" ON "AlertRule"("enabled");
CREATE INDEX IF NOT EXISTS "AlertRule_metric_idx" ON "AlertRule"("metric");

CREATE TABLE IF NOT EXISTS "AlertEvent" (
  "id"             TEXT NOT NULL,
  "ruleId"         TEXT NOT NULL,
  "value"          DOUBLE PRECISION NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'TRIGGERED',
  "triggeredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" TEXT,
  "resolvedAt"     TIMESTAMP(3),
  "resolvedBy"     TEXT,
  "notes"          TEXT,
  "notifications"  JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlertEvent_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AlertEvent_ruleId_status_idx"
  ON "AlertEvent"("ruleId", "status");
CREATE INDEX IF NOT EXISTS "AlertEvent_status_triggeredAt_idx"
  ON "AlertEvent"("status", "triggeredAt");
CREATE INDEX IF NOT EXISTS "AlertEvent_triggeredAt_idx"
  ON "AlertEvent"("triggeredAt");
