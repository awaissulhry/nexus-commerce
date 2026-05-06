-- Rollback for Commit 2 of the bulk-operations rebuild.
-- Drops the BulkActionItem table; BulkActionJob.errorLog JSON still
-- holds per-item failure data for backward compat.

DROP TABLE IF EXISTS "BulkActionItem";
