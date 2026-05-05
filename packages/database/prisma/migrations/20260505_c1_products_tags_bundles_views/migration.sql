-- C.1 — /products rebuild: Tag, ProductTag, Bundle, BundleComponent, SavedView
-- All five are net-new tables (no prior collisions checked via grep over
-- migrations/). Following the TECH_DEBT #38 lesson: NO `IF NOT EXISTS` on
-- the CREATE TABLEs so a silent collision becomes a loud error.
--
-- The DROPs guard against a partial-state replay on dev DBs where this
-- migration may have been attempted before being committed.

DROP TABLE IF EXISTS "BundleComponent" CASCADE;
DROP TABLE IF EXISTS "Bundle"          CASCADE;
DROP TABLE IF EXISTS "ProductTag"      CASCADE;
DROP TABLE IF EXISTS "SavedView"       CASCADE;
DROP TABLE IF EXISTS "Tag"             CASCADE;

-- ─── Tag ──────────────────────────────────────────────────────────────
CREATE TABLE "Tag" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL UNIQUE,
  "color"     TEXT,
  "metadata"  JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── ProductTag (many-to-many) ────────────────────────────────────────
CREATE TABLE "ProductTag" (
  "productId" TEXT NOT NULL,
  "tagId"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("productId","tagId"),
  CONSTRAINT "ProductTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE
);
CREATE INDEX "ProductTag_productId_idx" ON "ProductTag"("productId");
CREATE INDEX "ProductTag_tagId_idx"     ON "ProductTag"("tagId");

-- ─── Bundle + BundleComponent ─────────────────────────────────────────
CREATE TABLE "Bundle" (
  "id"                TEXT PRIMARY KEY,
  "productId"         TEXT NOT NULL UNIQUE,
  "name"              TEXT NOT NULL,
  "description"       TEXT,
  "computedCostCents" INTEGER NOT NULL DEFAULT 0,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BundleComponent" (
  "id"            TEXT PRIMARY KEY,
  "bundleId"      TEXT NOT NULL,
  "productId"     TEXT NOT NULL,
  "quantity"      INTEGER NOT NULL DEFAULT 1,
  "unitCostCents" INTEGER,
  CONSTRAINT "BundleComponent_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE,
  CONSTRAINT "BundleComponent_bundle_product_unique" UNIQUE ("bundleId","productId")
);
CREATE INDEX "BundleComponent_bundleId_idx"  ON "BundleComponent"("bundleId");
CREATE INDEX "BundleComponent_productId_idx" ON "BundleComponent"("productId");

-- ─── SavedView ────────────────────────────────────────────────────────
CREATE TABLE "SavedView" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  "surface"   TEXT NOT NULL DEFAULT 'products',
  "name"      TEXT NOT NULL,
  "filters"   JSONB NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavedView_user_surface_name_unique" UNIQUE ("userId","surface","name")
);
CREATE INDEX "SavedView_userId_surface_idx" ON "SavedView"("userId","surface");
