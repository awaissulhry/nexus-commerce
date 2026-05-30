-- PH.1 — Unified price-change timeline: PriceChangeSource enum +
-- PriceChangeEvent table (additive, online-safe — new type + new table,
-- no locks on existing tables). Append-only feed the /pricing drawer reads
-- to answer "why did this price change, and what was it before?".

-- CreateEnum
CREATE TYPE "PriceChangeSource" AS ENUM ('MANUAL_OVERRIDE', 'BULK_OVERRIDE', 'REPRICER', 'PROMO_START', 'PROMO_END', 'CHANNEL_RULE', 'MASTER_INHERIT', 'FX');

-- CreateTable
CREATE TABLE "PriceChangeEvent" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "fulfillmentMethod" TEXT,
    "oldPrice" DECIMAL(12,2),
    "newPrice" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" "PriceChangeSource" NOT NULL,
    "reason" TEXT NOT NULL,
    "ruleId" TEXT,
    "actor" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceChangeEvent_productId_channel_marketplace_changedAt_idx" ON "PriceChangeEvent"("productId", "channel", "marketplace", "changedAt");

-- CreateIndex
CREATE INDEX "PriceChangeEvent_sku_changedAt_idx" ON "PriceChangeEvent"("sku", "changedAt");

-- CreateIndex
CREATE INDEX "PriceChangeEvent_changedAt_idx" ON "PriceChangeEvent"("changedAt");

-- AddForeignKey
ALTER TABLE "PriceChangeEvent" ADD CONSTRAINT "PriceChangeEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
