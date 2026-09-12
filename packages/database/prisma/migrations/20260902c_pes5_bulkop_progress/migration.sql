-- D15.15 / PES.5 — the import job's progress counters.
--
-- ADDITIVE ONLY: two nullable columns on a table that already carries the rest
-- of the ruled job record (`changes` per cell, `status` with PARTIAL, `errors`,
-- `uploadFilename`, `expiresAt` = revertibleUntil). Nothing is dropped and no
-- existing row changes meaning — a NULL here means "never reported progress",
-- which is deliberately distinct from 0.
--
-- `status` stays a free-text column, so QUEUED / RUNNING / REVERTED need no
-- migration; and the per-change `scope` coordinate lives inside the `changes`
-- JSON, so it needs none either.
ALTER TABLE "BulkOperation" ADD COLUMN IF NOT EXISTS "processed" INTEGER;
ALTER TABLE "BulkOperation" ADD COLUMN IF NOT EXISTS "total" INTEGER;
