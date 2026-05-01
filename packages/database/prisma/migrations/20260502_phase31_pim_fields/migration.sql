-- Phase 31: PIM Master Catalog Fields
ALTER TABLE "Product"
  ADD COLUMN "isMaster"           BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN "masterSku"          TEXT,
  ADD COLUMN "variationAxes"      TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN "linkedToChannels"   TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN "importSource"       TEXT,
  ADD COLUMN "importedAt"         TIMESTAMP(3),
  ADD COLUMN "reviewStatus"       TEXT,
  ADD COLUMN "variantAttributes"  JSONB;

CREATE INDEX "Product_isMaster_idx" ON "Product" ("isMaster");
CREATE INDEX "Product_reviewStatus_idx" ON "Product" ("reviewStatus");
CREATE INDEX "Product_importSource_idx" ON "Product" ("importSource");
