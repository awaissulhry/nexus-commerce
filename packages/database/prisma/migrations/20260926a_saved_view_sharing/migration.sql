-- SHEET-VIEWS P2 (2026-09-26): team views and per-product-type default views on the product sheet.
-- Additive only (expand/contract): two columns with defaults, so the release still serving traffic keeps
-- reading and writing SavedView unchanged. IF NOT EXISTS keeps a re-run harmless on a database where the
-- file was applied directly.
ALTER TABLE "SavedView" ADD COLUMN IF NOT EXISTS "shared" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SavedView" ADD COLUMN IF NOT EXISTS "defaultProductTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
