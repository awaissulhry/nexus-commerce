-- IE.13 — second perceptual hash for the upload near-dup gate (additive).
-- 256-bit dHash (64 hex chars); NULL until upload or backfill computes it.
ALTER TABLE "ProductImage" ADD COLUMN "dhash256" TEXT;
