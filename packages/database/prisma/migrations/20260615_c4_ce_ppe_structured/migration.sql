-- C4 — structured CE/PPE protective-gear fields on Product: EN 17092 garment
-- class, Notified Body (number + name), Declaration of Conformity link, and the
-- EN 1621-1/-2/-4 impact protectors (JSON array of { zone, standard, level }).
-- Additive + nullable; idempotent, safe to run repeatedly.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "garmentClass" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "notifiedBodyNumber" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "notifiedBodyName" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "declarationOfConformityUrl" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "impactProtectors" JSONB;
