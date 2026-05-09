-- W8.1 — Import wizard depth: per-row tracked import jobs.

CREATE TABLE "ImportJob" (
  "id"            TEXT PRIMARY KEY,
  "jobName"       TEXT NOT NULL,
  "description"   TEXT,
  "source"        TEXT NOT NULL DEFAULT 'upload',
  "sourceUrl"     TEXT,
  "filename"      TEXT,
  "fileKind"      TEXT NOT NULL,
  "targetEntity"  TEXT NOT NULL,
  "columnMapping" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "onError"       TEXT NOT NULL DEFAULT 'skip',
  "status"        TEXT NOT NULL DEFAULT 'PENDING_PREVIEW',
  "totalRows"     INTEGER NOT NULL DEFAULT 0,
  "successRows"   INTEGER NOT NULL DEFAULT 0,
  "failedRows"    INTEGER NOT NULL DEFAULT 0,
  "skippedRows"   INTEGER NOT NULL DEFAULT 0,
  "errorSummary"  TEXT,
  "scheduleId"    TEXT,
  "parentJobId"   TEXT,
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"     TIMESTAMP(3),
  "completedAt"   TIMESTAMP(3),
  "updatedAt"     TIMESTAMP(3) NOT NULL
);

CREATE INDEX "ImportJob_status_createdAt_idx"
  ON "ImportJob"("status", "createdAt" DESC);
CREATE INDEX "ImportJob_scheduleId_idx" ON "ImportJob"("scheduleId");
CREATE INDEX "ImportJob_parentJobId_idx" ON "ImportJob"("parentJobId");

CREATE TABLE "ImportJobRow" (
  "id"            TEXT PRIMARY KEY,
  "jobId"         TEXT NOT NULL,
  "rowIndex"      INTEGER NOT NULL,
  "targetId"      TEXT,
  "parsedValues"  JSONB NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "errorMessage"  TEXT,
  "beforeState"   JSONB,
  "afterState"    JSONB,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"   TIMESTAMP(3),
  CONSTRAINT "ImportJobRow_jobId_fkey" FOREIGN KEY ("jobId")
    REFERENCES "ImportJob"("id") ON DELETE CASCADE
);

CREATE INDEX "ImportJobRow_jobId_status_idx"
  ON "ImportJobRow"("jobId", "status");
CREATE INDEX "ImportJobRow_targetId_idx" ON "ImportJobRow"("targetId");

CREATE TABLE "ScheduledImport" (
  "id"             TEXT PRIMARY KEY,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "source"         TEXT NOT NULL,
  "sourceUrl"      TEXT NOT NULL,
  "targetEntity"   TEXT NOT NULL,
  "columnMapping"  JSONB NOT NULL DEFAULT '{}'::jsonb,
  "onError"        TEXT NOT NULL DEFAULT 'skip',
  "cronExpression" TEXT,
  "scheduledFor"   TIMESTAMP(3),
  "timezone"       TEXT NOT NULL DEFAULT 'Europe/Rome',
  "nextRunAt"      TIMESTAMP(3),
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt"      TIMESTAMP(3),
  "lastJobId"      TEXT,
  "lastStatus"     TEXT,
  "lastError"      TEXT,
  "runCount"       INTEGER NOT NULL DEFAULT 0,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

CREATE INDEX "ScheduledImport_enabled_nextRunAt_idx"
  ON "ScheduledImport"("enabled", "nextRunAt");
