-- ============================================================================
-- Test Data Cleanup Script
-- ============================================================================
-- Purpose: Remove test/seed data while preserving real Xavia products
-- Last run: 2026-05-05
--
-- Usage:
--   Run on Neon SQL Editor in production
--   Or: psql $DATABASE_URL -f cleanup-test-data.sql
--
-- Safety:
--   - Idempotent (safe to re-run)
--   - Only deletes records with explicit test markers
--   - Real Xavia data (NULL or MANUAL importSource) is NEVER touched
-- ============================================================================

-- Section 1: Delete XAVIA_REALISTIC_TEST seed data (cascades to variations)
DELETE FROM "Product" WHERE "importSource" = 'XAVIA_REALISTIC_TEST';

-- Section 2: Delete PERFORMANCE_TEST data (legacy, may already be gone)
DELETE FROM "Product" WHERE "importSource" = 'PERFORMANCE_TEST';

-- Section 3: Delete empty drafts (created by accidental "New Product" clicks)
DELETE FROM "Product"
WHERE sku LIKE 'NEW-%'
  AND name = 'Untitled product'
  AND "basePrice" = 0;

-- Section 4: Delete stray test entries
DELETE FROM "Product" WHERE sku = 'test' AND name = 'test';

-- Verification (run separately to confirm clean state)
SELECT
  count(*) as total,
  count(*) FILTER (WHERE "importSource" IS NULL) as real_null_source,
  count(*) FILTER (WHERE "importSource" = 'MANUAL') as real_manual,
  count(*) FILTER (WHERE "importSource" = 'XAVIA_REALISTIC_TEST') as test_remaining,
  count(*) FILTER (WHERE "importSource" = 'PERFORMANCE_TEST') as legacy_test_remaining,
  count(*) FILTER (WHERE name = 'Untitled product') as empty_drafts_remaining,
  count(*) FILTER (WHERE sku = 'test') as stray_test_remaining
FROM "Product";

-- Expected after cleanup:
--   total                   = real product count (267 as of 2026-05-05)
--   real_null_source        = 262
--   real_manual             = 5
--   test_remaining          = 0
--   legacy_test_remaining   = 0
--   empty_drafts_remaining  = 0
--   stray_test_remaining    = 0
