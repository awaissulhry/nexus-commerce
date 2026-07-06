-- FF2 — flat-file import history.
-- Persists each flat-file import (preview → apply): the uploaded file handle,
-- the dry-run diff, the inverse diff (for one-click rollback), and the scope,
-- so imports are auditable and reversible.
--
-- Additive: a NEW table only — no changes to any existing table, no data move.
-- Reversible:
--   DROP TABLE "FlatFileImport";

CREATE TABLE "FlatFileImport" (
  "id"            TEXT NOT NULL,
  "channel"       TEXT NOT NULL,
  "markets"       JSONB NOT NULL,
  "includeMaster" BOOLEAN NOT NULL DEFAULT false,
  "snapshotId"    TEXT,
  "filename"      TEXT,
  "uploadHandle"  TEXT,
  "reportHandle"  TEXT,
  "diff"          JSONB,
  "inverseDiff"   JSONB,
  "status"        TEXT NOT NULL DEFAULT 'PREVIEW',
  "appliedCount"  INTEGER NOT NULL DEFAULT 0,
  "skippedCount"  INTEGER NOT NULL DEFAULT 0,
  "failedCount"   INTEGER NOT NULL DEFAULT 0,
  "rolledBackAt"  TIMESTAMP(3),
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FlatFileImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FlatFileImport_channel_createdAt_idx" ON "FlatFileImport"("channel", "createdAt" DESC);
CREATE INDEX "FlatFileImport_status_idx" ON "FlatFileImport"("status");
