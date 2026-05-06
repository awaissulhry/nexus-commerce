-- R.20 — cash flow projection.
-- Adds operator-entered cash position to BrandSettings.

ALTER TABLE "BrandSettings"
  ADD COLUMN "cashOnHandCents" INTEGER;
