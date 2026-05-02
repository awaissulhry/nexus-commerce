-- Phase D.3a rollback — for reference only (not auto-applied).
--
-- Run manually against the database if D.3 needs to be reverted:
--   psql $DATABASE_URL -f rollback.sql
--
-- Safe to run: every statement uses IF EXISTS.
-- After running, also remove the corresponding rows from
-- _prisma_migrations table or future migrations will think this one
-- was never applied:
--   DELETE FROM _prisma_migrations
--    WHERE migration_name = '20260502_phase_d3_cascade_categoryattrs_gtin';
--
-- Code-level rollback: revert schema.prisma additions and the D.3b/c/d/e
-- code that consumes these columns. The migration removal must happen
-- BEFORE the code rollback or new code will reference dropped columns.

DROP INDEX IF EXISTS "Product_gtin_idx";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "gtin";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "cascadedFields";

ALTER TABLE "BulkOperation" DROP COLUMN IF EXISTS "affectedChildren";
ALTER TABLE "BulkOperation" DROP COLUMN IF EXISTS "cascadeCount";
