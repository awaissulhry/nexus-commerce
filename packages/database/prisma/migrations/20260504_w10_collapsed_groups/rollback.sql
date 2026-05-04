-- Reverse of 20260504_w10_collapsed_groups.

BEGIN;

ALTER TABLE "BulkOpsTemplate"
  DROP COLUMN IF EXISTS "collapsedGroups";

COMMIT;
