-- RPT.5 — saved report definitions + version history.
-- Purely additive: two new tables, nothing existing is altered or dropped.

CREATE TABLE "SavedReport" (
    "id"          TEXT NOT NULL,
    "reportId"    TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "query"       JSONB NOT NULL,
    "ownerId"     TEXT NOT NULL DEFAULT 'default-user',
    "version"     INTEGER NOT NULL DEFAULT 1,
    "isArchived"  BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavedReportVersion" (
    "id"            TEXT NOT NULL,
    "savedReportId" TEXT NOT NULL,
    "version"       INTEGER NOT NULL,
    "name"          TEXT NOT NULL,
    "description"   TEXT,
    "query"         JSONB NOT NULL,
    "changeNote"    TEXT,
    "createdBy"     TEXT NOT NULL DEFAULT 'default-user',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SavedReportVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedReport_ownerId_isArchived_updatedAt_idx" ON "SavedReport"("ownerId", "isArchived", "updatedAt");
CREATE INDEX "SavedReport_reportId_idx" ON "SavedReport"("reportId");
CREATE UNIQUE INDEX "SavedReportVersion_savedReportId_version_key" ON "SavedReportVersion"("savedReportId", "version");
CREATE INDEX "SavedReportVersion_savedReportId_createdAt_idx" ON "SavedReportVersion"("savedReportId", "createdAt");

-- Cascade: a version has no meaning without the report it belongs to.
ALTER TABLE "SavedReportVersion"
  ADD CONSTRAINT "SavedReportVersion_savedReportId_fkey"
  FOREIGN KEY ("savedReportId") REFERENCES "SavedReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
