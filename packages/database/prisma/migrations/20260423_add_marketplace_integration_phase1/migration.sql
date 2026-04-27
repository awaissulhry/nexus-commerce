-- Phase 1: Marketplace Integration Foundation
-- Adds marketplace-specific fields for Shopify, WooCommerce, and Etsy

-- Add marketplace-specific variant IDs to ProductVariation
ALTER TABLE "ProductVariation" ADD COLUMN "shopifyVariantId" TEXT;
ALTER TABLE "ProductVariation" ADD COLUMN "woocommerceVariationId" INTEGER;
ALTER TABLE "ProductVariation" ADD COLUMN "etsyListingId" TEXT;
ALTER TABLE "ProductVariation" ADD COLUMN "etsySku" TEXT;

-- Add marketplace-specific product IDs to Product
ALTER TABLE "Product" ADD COLUMN "shopifyProductId" TEXT;
ALTER TABLE "Product" ADD COLUMN "woocommerceProductId" INTEGER;

-- Extend VariantChannelListing with sync retry tracking
-- NOTE: VariantChannelListing table is created in a later migration, so these columns are skipped here
-- ALTER TABLE "VariantChannelListing" ADD COLUMN "syncRetryCount" INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE "VariantChannelListing" ADD COLUMN "lastSyncError" TEXT;

-- Create WebhookEvent table for tracking incoming webhooks
CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "signature" TEXT,
  "isProcessed" BOOLEAN NOT NULL DEFAULT false,
  "processedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create unique index for idempotency (channel + externalId)
CREATE UNIQUE INDEX "WebhookEvent_channel_externalId_key" ON "WebhookEvent"("channel", "externalId");
CREATE INDEX "WebhookEvent_isProcessed_idx" ON "WebhookEvent"("isProcessed");
CREATE INDEX "WebhookEvent_channel_idx" ON "WebhookEvent"("channel");

-- Create MarketplaceCredential table for secure credential storage
CREATE TABLE "MarketplaceCredential" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "credentialType" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create unique index for channel + credentialType
CREATE UNIQUE INDEX "MarketplaceCredential_channel_credentialType_key" ON "MarketplaceCredential"("channel", "credentialType");
CREATE INDEX "MarketplaceCredential_channel_idx" ON "MarketplaceCredential"("channel");

-- Create RateLimitLog table for tracking API rate limits
CREATE TABLE "RateLimitLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create index for efficient rate limit lookups
CREATE UNIQUE INDEX "RateLimitLog_channel_endpoint_resetAt_key" ON "RateLimitLog"("channel", "endpoint", "resetAt");
CREATE INDEX "RateLimitLog_channel_idx" ON "RateLimitLog"("channel");
CREATE INDEX "RateLimitLog_resetAt_idx" ON "RateLimitLog"("resetAt");

-- Create SyncError table for detailed error tracking
CREATE TABLE "SyncError" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "errorType" TEXT NOT NULL,
  "errorMessage" TEXT NOT NULL,
  "errorStack" TEXT,
  "context" JSONB,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "maxRetries" INTEGER NOT NULL DEFAULT 3,
  "nextRetryAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for error tracking
CREATE INDEX "SyncError_channel_idx" ON "SyncError"("channel");
CREATE INDEX "SyncError_errorType_idx" ON "SyncError"("errorType");
CREATE INDEX "SyncError_nextRetryAt_idx" ON "SyncError"("nextRetryAt");
CREATE INDEX "SyncError_resolvedAt_idx" ON "SyncError"("resolvedAt");
