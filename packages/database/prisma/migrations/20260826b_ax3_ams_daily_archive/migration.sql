-- AX3 — a side table for daily rows that are duplicates of the report pipeline's own.
--
-- ADDITIVE ONLY. This migration creates a table and touches no data; the rows are moved by
-- `apps/api/scripts/_ax3-archive-ams-daily.mts`, which verifies the copy before it deletes
-- anything and rolls back as one transaction if the two sides disagree.
--
-- WHY IT IS NOT A PRISMA MODEL
-- `LIKE ... INCLUDING DEFAULTS` copies the source's column list exactly, today and whatever it
-- looked like when this ran. The source carries ~70 columns, many of them nullable-with-meaning
-- (SPC.1: null means "not requested", 0 means "Amazon said zero"), and hand-transcribing that
-- into a mirror model is one silent typo away from an archive that cannot restore what it holds.
-- The schema-drift gate checks model -> migration, so a table with no model is fine; the restore
-- script reads it with raw SQL, which is also a feature — nothing can accidentally JOIN it into
-- a live aggregate the way the originals were being summed into one.
--
-- Deliberately NO unique constraint and no indexes copied: an archive records what was removed,
-- including anything the live table's constraints would now reject.
CREATE TABLE IF NOT EXISTS "AmazonAdsDailyPerformanceArchive" (
  LIKE "AmazonAdsDailyPerformance" INCLUDING DEFAULTS
);

ALTER TABLE "AmazonAdsDailyPerformanceArchive"
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "archivedReason" TEXT NOT NULL DEFAULT 'unspecified';

-- The only access pattern an archive has: "show me everything removed for reason X".
CREATE INDEX IF NOT EXISTS "AmazonAdsDailyPerformanceArchive_reason_date_idx"
  ON "AmazonAdsDailyPerformanceArchive" ("archivedReason", "date");
