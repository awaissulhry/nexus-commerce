-- DropForeignKey
ALTER TABLE "ProductVariation" DROP CONSTRAINT "ProductVariation_productId_fkey";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "variationTheme" TEXT;

-- AlterTable
ALTER TABLE "ProductVariation" ADD COLUMN     "amazonAsin" TEXT,
ADD COLUMN     "costPrice" DECIMAL(10,2),
ADD COLUMN     "dimHeight" DECIMAL(10,2),
ADD COLUMN     "dimLength" DECIMAL(10,2),
ADD COLUMN     "dimUnit" TEXT,
ADD COLUMN     "dimWidth" DECIMAL(10,2),
ADD COLUMN     "ean" TEXT,
ADD COLUMN     "ebayVariationId" TEXT,
ADD COLUMN     "fulfillmentMethod" "FulfillmentMethod",
ADD COLUMN     "gtin" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mapPrice" DECIMAL(10,2),
ADD COLUMN     "maxPrice" DECIMAL(10,2),
ADD COLUMN     "minPrice" DECIMAL(10,2),
ADD COLUMN     "upc" TEXT,
ADD COLUMN     "variationAttributes" JSONB,
ADD COLUMN     "weightUnit" TEXT,
ADD COLUMN     "weightValue" DECIMAL(10,3),
ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "value" DROP NOT NULL;

-- CreateTable
CREATE TABLE "VariantImage" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "type" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantChannelListing" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelSku" TEXT,
    "channelProductId" TEXT,
    "channelPrice" DECIMAL(10,2) NOT NULL,
    "channelQuantity" INTEGER NOT NULL DEFAULT 0,
    "channelCategoryId" TEXT,
    "channelSpecificData" JSONB,
    "listingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,

    CONSTRAINT "VariantChannelListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VariantImage_variantId_idx" ON "VariantImage"("variantId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_variantId_idx" ON "VariantChannelListing"("variantId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_channelId_idx" ON "VariantChannelListing"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantChannelListing_variantId_channelId_key" ON "VariantChannelListing"("variantId", "channelId");

-- CreateIndex
CREATE INDEX "ProductVariation_productId_idx" ON "ProductVariation"("productId");

-- AddForeignKey
ALTER TABLE "ProductVariation" ADD CONSTRAINT "ProductVariation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantImage" ADD CONSTRAINT "VariantImage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantChannelListing" ADD CONSTRAINT "VariantChannelListing_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
