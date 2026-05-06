-- Cron observability: one row per cron invocation. Powers the
-- "did my 2am job fire?" answer in /dashboard/health and unblocks
-- per-job duration / failure-rate metrics.

CREATE TABLE IF NOT EXISTS "CronRun" (
  "id"             TEXT PRIMARY KEY,
  "jobName"        TEXT NOT NULL,
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"     TIMESTAMP(3),
  "status"         TEXT NOT NULL DEFAULT 'RUNNING',
  "errorMessage"   TEXT,
  "outputSummary"  TEXT,
  "triggeredBy"    TEXT NOT NULL DEFAULT 'cron',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "CronRun_jobName_startedAt_idx"
  ON "CronRun" ("jobName", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "CronRun_status_idx"
  ON "CronRun" ("status");
CREATE INDEX IF NOT EXISTS "CronRun_startedAt_idx"
  ON "CronRun" ("startedAt" DESC);
