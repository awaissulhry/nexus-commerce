-- FL.1 — Field Resolution & Linking engine: data model.
--
-- Adds the FieldLinkGroup table (+ two supporting enums) that backs the
-- "linked" rung of resolveField(channel, market, fieldKey, variantId?):
--   pinned override (ChannelListingOverride) → linked group (this) →
--   product master → schema default.
--
-- Pure additive: one new table + two new enum types. No existing table
-- altered, no column dropped, no row touched on apply. Empty until the
-- cockpit starts writing link groups (FL.3+).
--
-- Rollback:
--   DROP TABLE "FieldLinkGroup";
--   DROP TYPE "FieldTranslatePolicy";
--   DROP TYPE "FieldParentage";

-- CreateEnum
CREATE TYPE "FieldParentage" AS ENUM ('PARENT', 'CHILD');

-- CreateEnum
CREATE TYPE "FieldTranslatePolicy" AS ENUM ('TRANSLATE', 'VERBATIM', 'NONE');

-- CreateTable
CREATE TABLE "FieldLinkGroup" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "parentage" "FieldParentage" NOT NULL DEFAULT 'PARENT',
    "translatePolicy" "FieldTranslatePolicy" NOT NULL DEFAULT 'TRANSLATE',
    "members" JSONB NOT NULL DEFAULT '[]',
    "sourceLanguage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldLinkGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FieldLinkGroup_productId_idx" ON "FieldLinkGroup"("productId");

-- CreateIndex
CREATE INDEX "FieldLinkGroup_productId_fieldKey_idx" ON "FieldLinkGroup"("productId", "fieldKey");

-- AddForeignKey
ALTER TABLE "FieldLinkGroup" ADD CONSTRAINT "FieldLinkGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
