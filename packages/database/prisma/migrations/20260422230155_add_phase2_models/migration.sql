-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED', 'DENIED');

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('SP', 'SB', 'SD');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('ENABLED', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('WORKING', 'SHIPPED', 'IN_TRANSIT', 'RECEIVING', 'CLOSED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerName" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingAddress" JSONB,
ADD COLUMN     "trackingNumber" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "b2bMinQty" INTEGER,
ADD COLUMN     "b2bPrice" DECIMAL(10,2),
ADD COLUMN     "buyBoxPrice" DECIMAL(10,2),
ADD COLUMN     "competitorPrice" DECIMAL(10,2),
ADD COLUMN     "costPrice" DECIMAL(10,2),
ADD COLUMN     "firstInventoryDate" TIMESTAMP(3),
ADD COLUMN     "maxPrice" DECIMAL(10,2),
ADD COLUMN     "minPrice" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "Return" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "refundAmount" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FBAShipment" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "name" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'WORKING',
    "destinationFC" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FBAShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FBAShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantitySent" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FBAShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRuleProduct" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "PricingRuleProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerFeedback" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "buyerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CampaignType" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'ENABLED',
    "dailyBudget" DECIMAL(10,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spend" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sales" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discountType" TEXT NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "maxRedemptions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FBAShipment_shipmentId_key" ON "FBAShipment"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRuleProduct_ruleId_productId_key" ON "PricingRuleProduct"("ruleId", "productId");

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FBAShipmentItem" ADD CONSTRAINT "FBAShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "FBAShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FBAShipmentItem" ADD CONSTRAINT "FBAShipmentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleProduct" ADD CONSTRAINT "PricingRuleProduct_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PricingRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleProduct" ADD CONSTRAINT "PricingRuleProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
