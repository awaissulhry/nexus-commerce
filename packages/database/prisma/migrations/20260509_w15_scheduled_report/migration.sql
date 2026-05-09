-- DO.40 / W15 — ScheduledReport (operator-scheduled digest emails).
--
-- Hourly cron reads this table, finds rows due (frequency +
-- lastSentAt), renders an HTML dashboard summary, and emails it
-- via the existing Resend transport (apps/api/src/services/email/).
--
-- Idempotent CREATE IF NOT EXISTS so re-runs are no-ops.

CREATE TABLE IF NOT EXISTS "ScheduledReport" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL DEFAULT 'default-user',
  "email"      TEXT NOT NULL,
  "frequency"  TEXT NOT NULL,
  "hourLocal"  INTEGER NOT NULL DEFAULT 8,
  "viewId"     TEXT,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "lastSentAt" TIMESTAMP,
  "createdAt"  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP NOT NULL,

  CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ScheduledReport_userId_idx"
  ON "ScheduledReport"("userId");

CREATE INDEX IF NOT EXISTS "ScheduledReport_isActive_frequency_idx"
  ON "ScheduledReport"("isActive", "frequency");
