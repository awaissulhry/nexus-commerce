-- Owner-authorized reversal: keep deployed legacy JSON writers working until code migration.
-- Preserve the original applied LX.1 migration and all four additive columns.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "Product_localizedContent_readonly" ON "Product";
DROP FUNCTION IF EXISTS nexus_lx1_legacy_content_readonly();
COMMIT;
