-- Reverse of 20260504_t6_bulk_ops_templates.

BEGIN;

DROP INDEX IF EXISTS "BulkOpsTemplate_updatedAt_idx";
DROP INDEX IF EXISTS "BulkOpsTemplate_userId_idx";
DROP TABLE IF EXISTS "BulkOpsTemplate";

COMMIT;
