-- RPT.6 — scheduled delivery of saved reports + a delivery log.
-- Purely additive: two new tables, nothing existing is altered or dropped.

CREATE TABLE "ReportSchedule" (
    "id"            TEXT NOT NULL,
    "savedReportId" TEXT NOT NULL,
    "recipients"    TEXT NOT NULL,
    "format"        TEXT NOT NULL DEFAULT 'xlsx',
    "windowMode"    TEXT NOT NULL DEFAULT 'last30',
    "frequency"     TEXT NOT NULL,
    "hourLocal"     INTEGER NOT NULL DEFAULT 8,
    "dayOfWeek"     INTEGER,
    "dayOfMonth"    INTEGER,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt"    TIMESTAMP(3),
    "lastStatus"    TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReportDelivery" (
    "id"         TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "status"     TEXT NOT NULL,
    "format"     TEXT NOT NULL,
    "recipients" TEXT NOT NULL,
    "rows"       INTEGER NOT NULL DEFAULT 0,
    "fileName"   TEXT,
    "fileBytes"  INTEGER,
    "windowFrom" TEXT,
    "windowTo"   TEXT,
    "freshness"  JSONB,
    "staleNote"  TEXT,
    "messageId"  TEXT,
    "error"      TEXT,
    "durationMs" INTEGER,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReportSchedule_isActive_frequency_hourLocal_idx" ON "ReportSchedule"("isActive", "frequency", "hourLocal");
CREATE INDEX "ReportSchedule_savedReportId_idx" ON "ReportSchedule"("savedReportId");
CREATE INDEX "ReportDelivery_scheduleId_createdAt_idx" ON "ReportDelivery"("scheduleId", "createdAt");
CREATE INDEX "ReportDelivery_status_createdAt_idx" ON "ReportDelivery"("status", "createdAt");

ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_savedReportId_fkey"
  FOREIGN KEY ("savedReportId") REFERENCES "SavedReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
