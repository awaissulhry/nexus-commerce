-- CreateEnum
CREATE TYPE "FulfillmentMethod" AS ENUM ('FBA', 'FBM');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "aPlusContent" JSONB,
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "bulletPoints" TEXT[],
ADD COLUMN     "dimHeight" DECIMAL(10,2),
ADD COLUMN     "dimLength" DECIMAL(10,2),
ADD COLUMN     "dimUnit" TEXT,
ADD COLUMN     "dimWidth" DECIMAL(10,2),
ADD COLUMN     "ean" TEXT,
ADD COLUMN     "fulfillmentMethod" "FulfillmentMethod",
ADD COLUMN     "keywords" TEXT[],
ADD COLUMN     "manufacturer" TEXT,
ADD COLUMN     "upc" TEXT,
ADD COLUMN     "weightUnit" TEXT,
ADD COLUMN     "weightValue" DECIMAL(10,3);

-- CreateTable
CREATE TABLE "ProductVariation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariation_sku_key" ON "ProductVariation"("sku");

-- AddForeignKey
ALTER TABLE "ProductVariation" ADD CONSTRAINT "ProductVariation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
