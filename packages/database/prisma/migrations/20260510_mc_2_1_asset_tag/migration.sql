-- MC.2.1: Asset taxonomy via AssetTag join table.
-- Reuses the existing Tag model (shared with ProductTag + OrderTag)
-- so operator-set tags like "hero", "lifestyle", "racing-line" apply
-- to assets, products, and orders from a single vocabulary.

CREATE TABLE IF NOT EXISTS "AssetTag" (
  "assetId"   TEXT         NOT NULL,
  "tagId"     TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetTag_pkey" PRIMARY KEY ("assetId", "tagId")
);

CREATE INDEX IF NOT EXISTS "AssetTag_assetId_idx" ON "AssetTag"("assetId");
CREATE INDEX IF NOT EXISTS "AssetTag_tagId_idx"   ON "AssetTag"("tagId");

ALTER TABLE "AssetTag"
  ADD CONSTRAINT "AssetTag_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "DigitalAsset"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetTag"
  ADD CONSTRAINT "AssetTag_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
