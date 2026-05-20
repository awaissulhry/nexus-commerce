-- IR.6.1 — Gemini Vision analysis result fields on ProductImage.
--
-- Populated by the /analyze endpoint shipped in IR.6.2. All nullable
-- so existing rows stay un-analyzed until the operator opts in.
--
-- Replaces the manual hasWhiteBackground flag on ListingImage as the
-- source of truth — the editor inherits the analysis from the master
-- image via sourceProductImageId when resolving cell badges.

ALTER TABLE "ProductImage" ADD COLUMN "aiAnalyzedAt"         TIMESTAMP(3);
ALTER TABLE "ProductImage" ADD COLUMN "aiHasWhiteBackground" BOOLEAN;
ALTER TABLE "ProductImage" ADD COLUMN "aiFrameFillPct"       INTEGER;
ALTER TABLE "ProductImage" ADD COLUMN "aiHasTextOverlay"     BOOLEAN;
ALTER TABLE "ProductImage" ADD COLUMN "aiOffCenterScore"     DOUBLE PRECISION;
ALTER TABLE "ProductImage" ADD COLUMN "aiNotes"              JSONB;
