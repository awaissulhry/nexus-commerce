-- CreateTable
CREATE TABLE "SharedListingMembership" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "parentSku" TEXT NOT NULL,
    "productId" TEXT,
    "variationSpecifics" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastQtyPushed" INTEGER,
    "lastPushedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedListingMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SharedListingMembership_sku_marketplace_idx" ON "SharedListingMembership"("sku", "marketplace");

-- CreateIndex
CREATE INDEX "SharedListingMembership_productId_idx" ON "SharedListingMembership"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedListingMembership_marketplace_itemId_sku_key" ON "SharedListingMembership"("marketplace", "itemId", "sku");

