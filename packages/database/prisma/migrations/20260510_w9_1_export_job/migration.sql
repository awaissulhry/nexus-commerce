-- W9.1 — ExportJob + ScheduledExport: counterpart to ImportJob.

CREATE TABLE "ExportJob" (
  "id"             TEXT PRIMARY KEY,
  "jobName"        TEXT NOT NULL,
  "description"    TEXT,
  "format"         TEXT NOT NULL,
  "targetEntity"   TEXT NOT NULL,
  "columns"        JSONB NOT NULL DEFAULT '[]'::jsonb,
  "filters"        JSONB,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "rowCount"       INTEGER NOT NULL DEFAULT 0,
  "bytes"          INTEGER NOT NULL DEFAULT 0,
  "artifactBase64" TEXT,
  "artifactUrl"    TEXT,
  "errorMessage"   TEXT,
  "scheduleId"     TEXT,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"      TIMESTAMP(3),
  "completedAt"    TIMESTAMP(3),
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

CREATE INDEX "ExportJob_status_createdAt_idx"
  ON "ExportJob"("status", "createdAt" DESC);
CREATE INDEX "ExportJob_scheduleId_idx" ON "ExportJob"("scheduleId");

CREATE TABLE "ScheduledExport" (
  "id"             TEXT PRIMARY KEY,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "format"         TEXT NOT NULL,
  "targetEntity"   TEXT NOT NULL,
  "columns"        JSONB NOT NULL DEFAULT '[]'::jsonb,
  "filters"        JSONB,
  "delivery"       TEXT NOT NULL DEFAULT 'email',
  "deliveryTarget" TEXT,
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

CREATE INDEX "ScheduledExport_enabled_nextRunAt_idx"
  ON "ScheduledExport"("enabled", "nextRunAt");
