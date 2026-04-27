-- Add missing columns to Product table for parent/child hierarchy
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "isParent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "parentAsin" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "fulfillmentChannel" "FulfillmentMethod";
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "shippingTemplate" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "lastAmazonSync" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "amazonSyncStatus" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "amazonSyncError" TEXT;

-- Add foreign key constraint for parent relationship (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'Product_parentId_fkey'
  ) THEN
    ALTER TABLE "Product" ADD CONSTRAINT "Product_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Create SyncLog table if it doesn't exist
CREATE TABLE IF NOT EXISTS "SyncLog" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- Create indexes for SyncLog
CREATE INDEX IF NOT EXISTS "SyncLog_productId_idx" ON "SyncLog"("productId");
CREATE INDEX IF NOT EXISTS "SyncLog_status_idx" ON "SyncLog"("status");
CREATE INDEX IF NOT EXISTS "SyncLog_syncType_idx" ON "SyncLog"("syncType");

-- Create VariantChannelListing table if it doesn't exist
CREATE TABLE IF NOT EXISTS "VariantChannelListing" (
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
    "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantChannelListing_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for VariantChannelListing
CREATE UNIQUE INDEX IF NOT EXISTS "VariantChannelListing_variantId_channelId_key" ON "VariantChannelListing"("variantId", "channelId");
CREATE INDEX IF NOT EXISTS "VariantChannelListing_variantId_idx" ON "VariantChannelListing"("variantId");
CREATE INDEX IF NOT EXISTS "VariantChannelListing_channelId_idx" ON "VariantChannelListing"("channelId");

-- Add foreign key for VariantChannelListing if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'VariantChannelListing_variantId_fkey'
  ) THEN
    ALTER TABLE "VariantChannelListing" ADD CONSTRAINT "VariantChannelListing_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
