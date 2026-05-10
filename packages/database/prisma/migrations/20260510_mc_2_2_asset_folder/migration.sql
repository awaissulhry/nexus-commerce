-- MC.2.2: AssetFolder hierarchy + DigitalAsset.folderId.
-- Self-referential parentId for unbounded depth. SetNull on parent
-- delete promotes orphaned children to roots so deleting a folder
-- never silently drops the assets inside it.

CREATE TABLE IF NOT EXISTS "AssetFolder" (
  "id"        TEXT         NOT NULL,
  "name"      TEXT         NOT NULL,
  "parentId"  TEXT,
  "order"     INTEGER      NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetFolder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssetFolder_parentId_order_idx"
  ON "AssetFolder"("parentId", "order");

ALTER TABLE "AssetFolder"
  ADD CONSTRAINT "AssetFolder_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "AssetFolder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DigitalAsset" ADD COLUMN IF NOT EXISTS "folderId" TEXT;

CREATE INDEX IF NOT EXISTS "DigitalAsset_folderId_idx"
  ON "DigitalAsset"("folderId");

ALTER TABLE "DigitalAsset"
  ADD CONSTRAINT "DigitalAsset_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "AssetFolder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
