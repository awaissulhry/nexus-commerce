-- W10.2 — ETA + per-item duration tracking.
--
-- BulkActionJob.estimatedCompletionAt is computed at write time
-- inside the item-loop and surfaced via the SSE stream + the
-- ActiveJobsStrip ETA chip. BulkActionItem.durationMs is wall-
-- clock per-handler time so service-level p50/p95 reporting can
-- pull it directly without a follow-up join.
--
-- Both fields are nullable + additive — safe under concurrent
-- writes from in-flight bulk jobs.

ALTER TABLE "BulkActionJob"
  ADD COLUMN "estimatedCompletionAt" TIMESTAMP(3);

ALTER TABLE "BulkActionItem"
  ADD COLUMN "durationMs" INTEGER;
