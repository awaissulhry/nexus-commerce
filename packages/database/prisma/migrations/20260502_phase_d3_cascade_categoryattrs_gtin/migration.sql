-- Phase D.3a: cascade tracking + master-level GTIN + cascade audit
--
-- Schema additions only — no data writes, no destructive ops.
-- All statements idempotent so re-runs are safe.
--
-- Rollback companion: see rollback.sql in this directory.

-- ── Product additions ──────────────────────────────────────────────

-- cascadedFields: which fields on this row came from a parent cascade.
-- Updated by PATCH /api/products/bulk when cascade=true.
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "cascadedFields" TEXT[] NOT NULL DEFAULT '{}';

-- gtin: master-level GTIN for products without variations.
-- ProductVariation.gtin already exists for variant-level.
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "gtin" TEXT;

-- Index for GTIN lookups (matches ProductVariation_gtin pattern).
CREATE INDEX IF NOT EXISTS "Product_gtin_idx" ON "Product" ("gtin");

-- ── BulkOperation additions ────────────────────────────────────────

ALTER TABLE "BulkOperation"
  ADD COLUMN IF NOT EXISTS "cascadeCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "BulkOperation"
  ADD COLUMN IF NOT EXISTS "affectedChildren" TEXT[] NOT NULL DEFAULT '{}';
