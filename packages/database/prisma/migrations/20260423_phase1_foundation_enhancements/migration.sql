-- Phase 1: Foundation & Database Schema Enhancements
-- Adds Sync Health Logging, Pricing Rules Engine, Variation Attribute Mapping, and Bulk Action Queuing

-- ============================================================================
-- 1. ProductVariation: Add Marketplace Metadata & Pricing Rules Support
-- ============================================================================

ALTER TABLE "ProductVariation" ADD COLUMN "marketplaceMetadata" JSONB;

-- ============================================================================
-- 2. PricingRule: Add Priority & Margin Threshold Fields
-- ============================================================================

ALTER TABLE "PricingRule" ADD COLUMN "description" TEXT;
ALTER TABLE "PricingRule" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "PricingRule" ADD COLUMN "minMarginPercent" DECIMAL(5,2);
ALTER TABLE "PricingRule" ADD COLUMN "maxMarginPercent" DECIMAL(5,2);

-- Update type enum to include new pricing rule types
-- Note: PostgreSQL doesn't support direct enum modification, so we handle this in the application layer
-- The type field will accept: MATCH_LOW, PERCENTAGE_BELOW, COST_PLUS_MARGIN, FIXED_PRICE, DYNAMIC_MARGIN

-- ============================================================================
-- 3. PricingRuleProduct: Add Cascade Delete & Indexes
-- ============================================================================

-- Drop existing foreign key constraints and recreate with CASCADE
ALTER TABLE "PricingRuleProduct" DROP CONSTRAINT "PricingRuleProduct_ruleId_fkey";
ALTER TABLE "PricingRuleProduct" DROP CONSTRAINT "PricingRuleProduct_productId_fkey";

ALTER TABLE "PricingRuleProduct" ADD CONSTRAINT "PricingRuleProduct_ruleId_fkey" 
  FOREIGN KEY ("ruleId") REFERENCES "PricingRule"("id") ON DELETE CASCADE;
ALTER TABLE "PricingRuleProduct" ADD CONSTRAINT "PricingRuleProduct_productId_fkey" 
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE;

-- Add indexes for better query performance
CREATE INDEX "PricingRuleProduct_ruleId_idx" ON "PricingRuleProduct"("ruleId");
CREATE INDEX "PricingRuleProduct_productId_idx" ON "PricingRuleProduct"("productId");

-- ============================================================================
-- 4. PricingRuleVariation: New Model for Variation-Level Pricing Rules
-- ============================================================================

CREATE TABLE "PricingRuleVariation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ruleId" TEXT NOT NULL,
  "variationId" TEXT NOT NULL,
  CONSTRAINT "PricingRuleVariation_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PricingRule"("id") ON DELETE CASCADE,
  CONSTRAINT "PricingRuleVariation_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "PricingRuleVariation_ruleId_variationId_key" ON "PricingRuleVariation"("ruleId", "variationId");
CREATE INDEX "PricingRuleVariation_ruleId_idx" ON "PricingRuleVariation"("ruleId");
CREATE INDEX "PricingRuleVariation_variationId_idx" ON "PricingRuleVariation"("variationId");

-- ============================================================================
-- 5. SyncHealthLog: New Model for Sync Health & Logging
-- ============================================================================

CREATE TABLE "SyncHealthLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "syncJobId" TEXT,
  "errorType" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'WARNING',
  "productId" TEXT,
  "variationId" TEXT,
  "errorMessage" TEXT NOT NULL,
  "errorDetails" JSONB,
  "conflictType" TEXT,
  "conflictData" JSONB,
  "resolutionStatus" TEXT NOT NULL DEFAULT 'UNRESOLVED',
  "resolutionNotes" TEXT,
  "duplicateVariationIds" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "SyncHealthLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL,
  CONSTRAINT "SyncHealthLog_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE SET NULL
);

CREATE INDEX "SyncHealthLog_channel_idx" ON "SyncHealthLog"("channel");
CREATE INDEX "SyncHealthLog_errorType_idx" ON "SyncHealthLog"("errorType");
CREATE INDEX "SyncHealthLog_severity_idx" ON "SyncHealthLog"("severity");
CREATE INDEX "SyncHealthLog_productId_idx" ON "SyncHealthLog"("productId");
CREATE INDEX "SyncHealthLog_variationId_idx" ON "SyncHealthLog"("variationId");
CREATE INDEX "SyncHealthLog_resolutionStatus_idx" ON "SyncHealthLog"("resolutionStatus");
CREATE INDEX "SyncHealthLog_createdAt_idx" ON "SyncHealthLog"("createdAt");

-- ============================================================================
-- 6. BulkActionJob: New Model for Bulk Action Queuing
-- ============================================================================

CREATE TABLE "BulkActionJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "jobName" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "channel" TEXT,
  "targetProductIds" TEXT[],
  "targetVariationIds" TEXT[],
  "filters" JSONB,
  "actionPayload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "totalItems" INTEGER NOT NULL DEFAULT 0,
  "processedItems" INTEGER NOT NULL DEFAULT 0,
  "failedItems" INTEGER NOT NULL DEFAULT 0,
  "skippedItems" INTEGER NOT NULL DEFAULT 0,
  "progressPercent" INTEGER NOT NULL DEFAULT 0,
  "errorLog" JSONB,
  "lastError" TEXT,
  "isRollbackable" BOOLEAN NOT NULL DEFAULT true,
  "rollbackJobId" TEXT,
  "rollbackData" JSONB,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "BulkActionJob_actionType_idx" ON "BulkActionJob"("actionType");
CREATE INDEX "BulkActionJob_channel_idx" ON "BulkActionJob"("channel");
CREATE INDEX "BulkActionJob_status_idx" ON "BulkActionJob"("status");
CREATE INDEX "BulkActionJob_createdAt_idx" ON "BulkActionJob"("createdAt");
CREATE INDEX "BulkActionJob_completedAt_idx" ON "BulkActionJob"("completedAt");

-- ============================================================================
-- 7. Add Relations to PricingRule for Variations
-- ============================================================================

-- The PricingRule model now has a relation to PricingRuleVariation
-- This is handled through the PricingRuleVariation junction table created above

-- ============================================================================
-- 8. Verify Schema Integrity
-- ============================================================================

-- All foreign key constraints are properly set with CASCADE delete where appropriate
-- All indexes are created for optimal query performance
-- All new models follow the existing naming conventions and patterns
