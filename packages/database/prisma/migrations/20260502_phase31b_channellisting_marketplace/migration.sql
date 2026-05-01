-- Phase 31b: Backfill missing tables (ChannelListing, ChannelListingOverride,
-- ChannelListingImage, Offer, OutboundSyncQueue) + add Marketplace lookup
-- + add marketplace column to ChannelListing.
--
-- Idempotent: every statement uses IF NOT EXISTS or DO block so it's safe to
-- re-run against any database state. The schema and migrations had drifted
-- (these models lived only in schema.prisma), so this migration brings the
-- DB back into alignment without disturbing existing data.

-- ── Enums (DO blocks for idempotency — Postgres has no CREATE TYPE IF NOT EXISTS) ──

DO $$ BEGIN
  CREATE TYPE "PricingRuleType" AS ENUM ('FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SyncChannel" AS ENUM ('AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "OutboundSyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ChannelListing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stockBuffer" INTEGER NOT NULL DEFAULT 0,
    "channelMarket" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "externalListingId" TEXT,
    "externalParentId" TEXT,
    "platformProductId" TEXT,
    "title" TEXT,
    "description" TEXT,
    "price" DECIMAL(10,2),
    "salePrice" DECIMAL(10,2),
    "pricingRule" "PricingRuleType" NOT NULL DEFAULT 'FIXED',
    "priceAdjustmentPercent" DECIMAL(5,2),
    "quantity" INTEGER,
    "platformAttributes" JSONB,
    "variationTheme" TEXT,
    "variationMapping" JSONB,
    "listingStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
    "syncFromMaster" BOOLEAN NOT NULL DEFAULT false,
    "syncLocked" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "followMasterTitle" BOOLEAN NOT NULL DEFAULT true,
    "followMasterDescription" BOOLEAN NOT NULL DEFAULT true,
    "followMasterPrice" BOOLEAN NOT NULL DEFAULT true,
    "followMasterQuantity" BOOLEAN NOT NULL DEFAULT true,
    "followMasterImages" BOOLEAN NOT NULL DEFAULT true,
    "followMasterBulletPoints" BOOLEAN NOT NULL DEFAULT true,
    "masterTitle" TEXT,
    "masterDescription" TEXT,
    "masterPrice" DECIMAL(10,2),
    "masterQuantity" INTEGER,
    "masterBulletPoints" TEXT[],
    "titleOverride" TEXT,
    "descriptionOverride" TEXT,
    "priceOverride" DECIMAL(10,2),
    "quantityOverride" INTEGER,
    "bulletPointsOverride" TEXT[],
    "syncStatus" TEXT NOT NULL DEFAULT 'IDLE',
    "syncRetryLastAt" TIMESTAMP(3),
    "validationStatus" TEXT NOT NULL DEFAULT 'VALID',
    "validationErrors" TEXT[],
    "lastOverrideAt" TIMESTAMP(3),
    "lastOverrideBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChannelListing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ChannelListingOverride" (
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "changedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChannelListingOverride_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Offer" (
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "fulfillmentMethod" "FulfillmentMethod" NOT NULL,
    "sku" TEXT NOT NULL,
    "price" DECIMAL(10,2),
    "quantity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "offerMetadata" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ChannelListingImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "channelListingId" TEXT,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "type" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "platformMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChannelListingImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OutboundSyncQueue" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "channelListingId" TEXT,
    "offerId" TEXT,
    "targetChannel" "SyncChannel" NOT NULL DEFAULT 'AMAZON',
    "targetRegion" TEXT,
    "syncStatus" "OutboundSyncStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "holdUntil" TIMESTAMP(3),
    "syncType" TEXT NOT NULL,
    "externalListingId" TEXT,
    CONSTRAINT "OutboundSyncQueue_pkey" PRIMARY KEY ("id")
);

-- ── New Marketplace lookup table ───────────────────────────────────

CREATE TABLE IF NOT EXISTS "Marketplace" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplaceId" TEXT,
    "region" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "domainUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Marketplace_pkey" PRIMARY KEY ("id")
);

-- ── New marketplace column on ChannelListing (additive) ────────────

ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "marketplace" TEXT NOT NULL DEFAULT 'DEFAULT';

-- ── Indexes ────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "ChannelListing_productId_idx" ON "ChannelListing"("productId");
CREATE INDEX IF NOT EXISTS "ChannelListing_channel_idx" ON "ChannelListing"("channel");
CREATE INDEX IF NOT EXISTS "ChannelListing_region_idx" ON "ChannelListing"("region");
CREATE INDEX IF NOT EXISTS "ChannelListing_externalListingId_idx" ON "ChannelListing"("externalListingId");
CREATE INDEX IF NOT EXISTS "ChannelListing_listingStatus_idx" ON "ChannelListing"("listingStatus");
CREATE INDEX IF NOT EXISTS "ChannelListing_syncStatus_idx" ON "ChannelListing"("syncStatus");
CREATE INDEX IF NOT EXISTS "ChannelListing_validationStatus_idx" ON "ChannelListing"("validationStatus");
CREATE INDEX IF NOT EXISTS "ChannelListing_marketplace_idx" ON "ChannelListing"("marketplace");
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_key" ON "ChannelListing"("productId", "channelMarket");
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_key" ON "ChannelListing"("productId", "channel", "marketplace");

CREATE INDEX IF NOT EXISTS "ChannelListingOverride_channelListingId_idx" ON "ChannelListingOverride"("channelListingId");
CREATE INDEX IF NOT EXISTS "ChannelListingOverride_fieldName_idx" ON "ChannelListingOverride"("fieldName");
CREATE INDEX IF NOT EXISTS "ChannelListingOverride_isActive_idx" ON "ChannelListingOverride"("isActive");

CREATE INDEX IF NOT EXISTS "Offer_channelListingId_idx" ON "Offer"("channelListingId");
CREATE INDEX IF NOT EXISTS "Offer_fulfillmentMethod_idx" ON "Offer"("fulfillmentMethod");
CREATE INDEX IF NOT EXISTS "Offer_isActive_idx" ON "Offer"("isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "Offer_channelListingId_fulfillmentMethod_key" ON "Offer"("channelListingId", "fulfillmentMethod");

CREATE INDEX IF NOT EXISTS "ChannelListingImage_productId_idx" ON "ChannelListingImage"("productId");
CREATE INDEX IF NOT EXISTS "ChannelListingImage_channelListingId_idx" ON "ChannelListingImage"("channelListingId");

CREATE INDEX IF NOT EXISTS "OutboundSyncQueue_productId_idx" ON "OutboundSyncQueue"("productId");
CREATE INDEX IF NOT EXISTS "OutboundSyncQueue_channelListingId_idx" ON "OutboundSyncQueue"("channelListingId");
CREATE INDEX IF NOT EXISTS "OutboundSyncQueue_syncStatus_idx" ON "OutboundSyncQueue"("syncStatus");
CREATE INDEX IF NOT EXISTS "OutboundSyncQueue_targetChannel_idx" ON "OutboundSyncQueue"("targetChannel");
CREATE INDEX IF NOT EXISTS "OutboundSyncQueue_nextRetryAt_idx" ON "OutboundSyncQueue"("nextRetryAt");

CREATE INDEX IF NOT EXISTS "Marketplace_channel_idx" ON "Marketplace"("channel");
CREATE UNIQUE INDEX IF NOT EXISTS "Marketplace_channel_code_key" ON "Marketplace"("channel", "code");

-- ── Foreign keys (DO blocks — Postgres has no ADD CONSTRAINT IF NOT EXISTS) ──

DO $$ BEGIN
  ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ChannelListingOverride" ADD CONSTRAINT "ChannelListingOverride_channelListingId_fkey"
    FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Offer" ADD CONSTRAINT "Offer_channelListingId_fkey"
    FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ChannelListingImage" ADD CONSTRAINT "ChannelListingImage_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ChannelListingImage" ADD CONSTRAINT "ChannelListingImage_channelListingId_fkey"
    FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "OutboundSyncQueue" ADD CONSTRAINT "OutboundSyncQueue_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "OutboundSyncQueue" ADD CONSTRAINT "OutboundSyncQueue_channelListingId_fkey"
    FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Backfill marketplace column from channelMarket (e.g. "AMAZON_IT" → "IT") ──
-- Safe to run repeatedly: only updates rows still at the default 'DEFAULT'.
UPDATE "ChannelListing"
SET "marketplace" = CASE
  WHEN "channelMarket" LIKE '%\_%' ESCAPE '\' THEN split_part("channelMarket", '_', 2)
  WHEN "region" IS NOT NULL AND "region" <> '' THEN "region"
  WHEN "channel" IN ('SHOPIFY','WOOCOMMERCE','ETSY') THEN 'GLOBAL'
  ELSE 'DEFAULT'
END
WHERE "marketplace" = 'DEFAULT';
