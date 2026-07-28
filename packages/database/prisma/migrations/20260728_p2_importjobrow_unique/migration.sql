-- Phase 2 — bulksheet apply idempotency.
--
-- apply.ts guards against re-applying a row with `ImportJobRow.status ===
-- 'SUCCESS'`, but there was NO unique constraint on (jobId, rowIndex) and no
-- lock on the apply endpoint. Two concurrent POSTs both passed the plan-token
-- check, both read status !== 'SUCCESS', and both wrote — applying every row
-- twice.
--
-- The constraint makes the second writer fail at the database rather than
-- relying on read-then-write timing. Written defensively: if duplicates already
-- exist the index cannot be created, so we report them instead of failing the
-- deploy silently.

DO $$
DECLARE dupes INT;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT "jobId", "rowIndex" FROM "ImportJobRow"
    GROUP BY "jobId", "rowIndex" HAVING COUNT(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE WARNING 'ImportJobRow has % duplicate (jobId,rowIndex) pairs — unique index NOT created. Deduplicate, then re-run this migration.', dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "ImportJobRow_jobId_rowIndex_key"
      ON "ImportJobRow" ("jobId", "rowIndex");
  END IF;
END $$;
