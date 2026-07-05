-- FF1 — persist the workbook export snapshot on ExportJob.
-- snapshotId mirrors the hidden _meta sheet; marketList records the
-- channel→market set resolved at export time. Both are read by FF2's
-- import staleness / conflict detection.
--
-- Additive, nullable, non-destructive. No backfill, no data movement.
-- Reversible:
--   ALTER TABLE "ExportJob" DROP COLUMN "snapshotId", DROP COLUMN "marketList";

ALTER TABLE "ExportJob" ADD COLUMN "snapshotId" TEXT;
ALTER TABLE "ExportJob" ADD COLUMN "marketList" JSONB;
