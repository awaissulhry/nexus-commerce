-- Phase D.5: master-level description on Product.
--
-- description is HTML body shown on listings; populated by ZIP
-- uploads via description.html and the spreadsheet/CSV grid. Idempotent
-- ADD COLUMN — safe to re-run.

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "description" TEXT;
