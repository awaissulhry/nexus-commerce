-- GENERATED — do not hand-edit.
--
-- Source: prisma/schema.prisma.  Regenerate: node scripts/generate-baseline.mjs
-- Verified by: scripts/baseline.vitest.test.ts — a database built from this file is compared back
-- against schema.prisma, and the ONLY difference allowed is the dbgenerated workspaceId default
-- that Prisma cannot round-trip. Anything else is drift and fails.
--
-- This is the from-empty schema for a FRESH database. It is NOT a migration: it lives outside
-- prisma/migrations/ so Prisma never applies it, and it never touches a deployed database.
-- See scripts/generate-baseline.mjs for why the 467-migration history cannot be replayed instead.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "FulfillmentMethod" AS ENUM ('FBA', 'FBM');

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('SP', 'SB', 'SD', 'DSP');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('ENABLED', 'PAUSED', 'ARCHIVED', 'DRAFT');

-- CreateEnum
CREATE TYPE "BiddingStrategy" AS ENUM ('LEGACY_FOR_SALES', 'AUTO_FOR_SALES', 'MANUAL');

-- CreateEnum
CREATE TYPE "AdSyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('WORKING', 'SHIPPED', 'IN_TRANSIT', 'RECEIVING', 'CLOSED');

-- CreateEnum
CREATE TYPE "SyncChannel" AS ENUM ('AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'GOOGLE', 'META', 'TIKTOK');

-- CreateEnum
CREATE TYPE "OutboundSyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PricingRuleType" AS ENUM ('FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER');

-- CreateEnum
CREATE TYPE "FieldParentage" AS ENUM ('PARENT', 'CHILD');

-- CreateEnum
CREATE TYPE "FieldTranslatePolicy" AS ENUM ('TRANSLATE', 'VERBATIM', 'NONE');

-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('OWNER', 'ADMIN', 'OPS_MANAGER', 'FULFILLMENT', 'FINANCE', 'VIEWER');

-- CreateEnum
CREATE TYPE "ChannelStockEventStatus" AS ENUM ('PENDING', 'AUTO_APPLIED', 'REVIEW_NEEDED', 'APPLIED', 'IGNORED');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'PARTIALLY_SHIPPED', 'ON_HOLD', 'AWAITING_PAYMENT', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED');

-- CreateEnum
CREATE TYPE "PriceChangeSource" AS ENUM ('MANUAL_OVERRIDE', 'BULK_OVERRIDE', 'REPRICER', 'PROMO_START', 'PROMO_END', 'CHANNEL_RULE', 'MASTER_INHERIT', 'FX', 'CHANNEL_FILE_IMPORT');

-- CreateEnum
CREATE TYPE "ImageScope" AS ENUM ('GLOBAL', 'PLATFORM', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "ImageRole" AS ENUM ('MAIN', 'GALLERY', 'INFOGRAPHIC', 'LIFESTYLE', 'SIZE_CHART', 'SWATCH');

-- CreateEnum
CREATE TYPE "StockMovementReason" AS ENUM ('ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'RETURN_RECEIVED', 'RETURN_RESTOCKED', 'INBOUND_RECEIVED', 'SUPPLIER_DELIVERY', 'MANUFACTURING_OUTPUT', 'FBA_TRANSFER_OUT', 'FBA_TRANSFER_IN', 'MANUAL_ADJUSTMENT', 'INVENTORY_COUNT', 'WRITE_OFF', 'RESERVATION_RELEASED', 'SYNC_RECONCILIATION', 'RESERVATION_CREATED', 'RESERVATION_CONSUMED', 'TRANSFER_OUT', 'TRANSFER_IN', 'PARENT_PRODUCT_CLEANUP', 'STOCKLEVEL_BACKFILL', 'CHANNEL_STOCK_RECONCILIATION');

-- CreateEnum
CREATE TYPE "ShipmentStatusFBM" AS ENUM ('DRAFT', 'READY_TO_PICK', 'PICKED', 'PACKED', 'LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'RETURNED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "ReturnStatusFlow" AS ENUM ('REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING', 'RESTOCKED', 'REFUNDED', 'REJECTED', 'SCRAPPED');

-- CreateEnum
CREATE TYPE "ReturnConditionGrade" AS ENUM ('NEW', 'LIKE_NEW', 'GOOD', 'DAMAGED', 'UNUSABLE');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'SUBMITTED', 'ACKNOWLEDGED', 'CONFIRMED', 'PARTIAL', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InboundType" AS ENUM ('FBA', 'SUPPLIER', 'MANUFACTURING', 'TRANSFER');

-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'CLOSED', 'CANCELLED', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "CarrierCode" AS ENUM ('SENDCLOUD', 'AMAZON_BUY_SHIPPING', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReplenishmentUrgency" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "TrackingMessageStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCESS', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "RefundKind" AS ENUM ('CASH', 'STORE_CREDIT', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "RefundChannelStatus" AS ENUM ('PENDING', 'POSTED', 'FAILED', 'MANUAL_REQUIRED', 'NOT_IMPLEMENTED');

-- CreateEnum
CREATE TYPE "ReviewRequestStatus" AS ENUM ('ELIGIBLE', 'SCHEDULED', 'SENT', 'SUPPRESSED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReviewRuleScope" AS ENUM ('AMAZON_PER_MARKETPLACE', 'AMAZON_GLOBAL', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL');

-- CreateEnum
CREATE TYPE "MktChannel" AS ENUM ('AMAZON', 'EBAY', 'SHOPIFY', 'GOOGLE', 'META', 'TIKTOK', 'INTERNAL');

-- CreateEnum
CREATE TYPE "MktSurface" AS ENUM ('SP', 'SB', 'SD', 'PROMOTED_LISTINGS', 'DISCOUNT', 'MARKDOWN', 'DEAL', 'SHOPPING_FEED', 'CONTENT_PUSH', 'EMAIL_OUTREACH', 'REVIEW_OUTREACH');

-- CreateEnum
CREATE TYPE "MktObjective" AS ENUM ('SALES', 'AWARENESS', 'LIQUIDATION', 'NTB', 'TRAFFIC', 'RETENTION');

-- CreateEnum
CREATE TYPE "MktStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'SUSPENDED', 'FAILED');

-- CreateTable
CREATE TABLE "Product" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "totalStock" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 10,
    "amazonAsin" TEXT,
    "ebayItemId" TEXT,
    "ebayTitle" TEXT,
    "shopifyProductId" TEXT,
    "woocommerceProductId" INTEGER,
    "upc" TEXT,
    "ean" TEXT,
    "brand" TEXT,
    "manufacturer" TEXT,
    "weightValue" DECIMAL(10,3),
    "weightUnit" TEXT,
    "dimLength" DECIMAL(10,2),
    "dimWidth" DECIMAL(10,2),
    "dimHeight" DECIMAL(10,2),
    "dimUnit" TEXT,
    "description" TEXT,
    "bulletPoints" TEXT[],
    "aPlusContent" JSONB,
    "keywords" TEXT[],
    "fulfillmentMethod" "FulfillmentMethod",
    "variationTheme" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "productType" TEXT,
    "categoryAttributes" JSONB,
    "localizedContent" JSONB NOT NULL DEFAULT '{"en":{},"it":{}}',
    "familyId" TEXT,
    "workflowStageId" TEXT,
    "costPrice" DECIMAL(10,2),
    "minMargin" DECIMAL(5,2),
    "minPrice" DECIMAL(10,2),
    "maxPrice" DECIMAL(10,2),
    "buyBoxPrice" DECIMAL(10,2),
    "competitorPrice" DECIMAL(10,2),
    "firstInventoryDate" TIMESTAMP(3),
    "abcClass" TEXT,
    "abcClassUpdatedAt" TIMESTAMP(3),
    "costingMethod" TEXT NOT NULL DEFAULT 'WAC',
    "weightedAvgCostCents" INTEGER,
    "b2bPrice" DECIMAL(10,2),
    "b2bMinQty" INTEGER,
    "isParent" BOOLEAN NOT NULL DEFAULT false,
    "isBundle" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "parentAsin" TEXT,
    "fulfillmentChannel" "FulfillmentMethod",
    "shippingTemplate" TEXT,
    "lastAmazonSync" TIMESTAMP(3),
    "amazonSyncStatus" TEXT,
    "amazonSyncError" TEXT,
    "isMasterProduct" BOOLEAN NOT NULL DEFAULT true,
    "masterProductId" TEXT,
    "cascadedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gtin" TEXT,
    "fnsku" TEXT,
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "masterSku" TEXT,
    "variationAxes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "variationAxisCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "variationValueOrder" JSONB,
    "linkedToChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importSource" TEXT,
    "importedAt" TIMESTAMP(3),
    "reviewStatus" TEXT,
    "variantAttributes" JSONB,
    "imageAxisPreference" TEXT,
    "syncChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validationStatus" TEXT NOT NULL DEFAULT 'VALID',
    "validationErrors" TEXT[],
    "hasChannelOverrides" BOOLEAN NOT NULL DEFAULT false,
    "lastChannelOverrideAt" TIMESTAMP(3),
    "hsCode" TEXT,
    "countryOfOrigin" TEXT,
    "ppeCategory" TEXT,
    "hazmatClass" TEXT,
    "hazmatUnNumber" TEXT,
    "garmentClass" TEXT,
    "notifiedBodyNumber" TEXT,
    "notifiedBodyName" TEXT,
    "declarationOfConformityUrl" TEXT,
    "impactProtectors" JSONB,
    "serviceLevelPercent" DECIMAL(5,2),
    "orderingCostCents" INTEGER,
    "carryingCostPctYear" DECIMAL(5,2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkuAlias" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkuAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockImportJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "filename" TEXT,
    "fileKind" TEXT,
    "locationCode" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorSummary" TEXT,
    "results" JSONB,
    "startedAt" TIMESTAMP(3),
    "progressAt" TIMESTAMP(3),
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "revertedByJobId" TEXT,

    CONSTRAINT "StockImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductFamily" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "parentFamilyId" TEXT,
    "workflowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomAttribute" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "groupId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "validation" JSONB,
    "defaultValue" JSONB,
    "localizable" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "semanticKey" TEXT,
    "placement" TEXT NOT NULL DEFAULT 'shared',
    "placementChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeOption" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "metadata" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "synonyms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyAttribute" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "channels" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductWorkflow" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "slaHours" INTEGER,
    "isPublishable" BOOLEAN NOT NULL DEFAULT false,
    "isInitial" BOOLEAN NOT NULL DEFAULT false,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTransition" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT NOT NULL,
    "userId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowComment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "userId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAssignment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stageId" TEXT,
    "assigneeId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'REVIEWER',
    "assignedById" TEXT,
    "dueAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTierPrice" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minQty" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "customerGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductTierPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigitalAsset" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'image',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageProvider" TEXT NOT NULL DEFAULT 'cloudinary',
    "storageId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "originalFilename" TEXT,
    "contentHash" TEXT,
    "metadata" JSONB,
    "folderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigitalAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetFolder" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetUsage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "productId" TEXT,
    "role" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepricingRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minPrice" DECIMAL(10,2) NOT NULL,
    "maxPrice" DECIMAL(10,2) NOT NULL,
    "strategy" TEXT NOT NULL,
    "beatPct" DECIMAL(5,2),
    "beatAmount" DECIMAL(10,2),
    "activeFromHour" INTEGER,
    "activeToHour" INTEGER,
    "activeDays" INTEGER[],
    "notes" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastDecisionPrice" DECIMAL(10,2),
    "lastDecisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepricingDecision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "oldPrice" DECIMAL(10,2) NOT NULL,
    "newPrice" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "buyBoxPrice" DECIMAL(10,2),
    "lowestCompPrice" DECIMAL(10,2),
    "competitorCount" INTEGER,
    "applied" BOOLEAN NOT NULL,
    "capped" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepricingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "variationAttributes" JSONB,
    "lockedAttributes" JSONB DEFAULT '{}',
    "name" TEXT,
    "value" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "costPrice" DECIMAL(10,2),
    "minPrice" DECIMAL(10,2),
    "maxPrice" DECIMAL(10,2),
    "mapPrice" DECIMAL(10,2),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "stockBuffer" INTEGER NOT NULL DEFAULT 0,
    "upc" TEXT,
    "ean" TEXT,
    "gtin" TEXT,
    "weightValue" DECIMAL(10,3),
    "weightUnit" TEXT,
    "dimLength" DECIMAL(10,2),
    "dimWidth" DECIMAL(10,2),
    "dimHeight" DECIMAL(10,2),
    "dimUnit" TEXT,
    "fulfillmentMethod" "FulfillmentMethod",
    "amazonAsin" TEXT,
    "ebayVariationId" TEXT,
    "shopifyVariantId" TEXT,
    "woocommerceVariationId" INTEGER,
    "etsyListingId" TEXT,
    "etsySku" TEXT,
    "marketplaceMetadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantImage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "channelId" TEXT,
    "channelConnectionId" TEXT,
    "channel" TEXT,
    "marketplace" TEXT NOT NULL DEFAULT 'GLOBAL',
    "channelSku" TEXT,
    "channelProductId" TEXT,
    "externalListingId" TEXT,
    "externalSku" TEXT,
    "channelPrice" DECIMAL(10,2) NOT NULL,
    "channelQuantity" INTEGER NOT NULL DEFAULT 0,
    "currentPrice" DECIMAL(10,2),
    "quantity" INTEGER,
    "quantitySold" INTEGER NOT NULL DEFAULT 0,
    "channelCategoryId" TEXT,
    "listingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "listingUrl" TEXT,
    "channelSpecificData" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncError" TEXT,

    CONSTRAINT "VariantChannelListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelListing" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stockBuffer" INTEGER NOT NULL DEFAULT 0,
    "fulfillmentMethod" "FulfillmentMethod",
    "channelMarket" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'DEFAULT',
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
    "flatFileSnapshot" JSONB,
    "offerClosedAt" TIMESTAMP(3),
    "offerClosedBy" TEXT,
    "offerCloseReason" TEXT,
    "offerCloseSnapshot" JSONB,
    "overrideData" JSONB NOT NULL DEFAULT '{}',
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
    "offerActive" BOOLEAN NOT NULL DEFAULT true,
    "followMasterTitle" BOOLEAN NOT NULL DEFAULT true,
    "followMasterDescription" BOOLEAN NOT NULL DEFAULT true,
    "followMasterPrice" BOOLEAN NOT NULL DEFAULT true,
    "followMasterQuantity" BOOLEAN NOT NULL DEFAULT true,
    "syncPaused" BOOLEAN NOT NULL DEFAULT false,
    "pinnedUntil" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "sourceLocationCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
    "estimatedFbaFee" DECIMAL(10,2),
    "referralFeePercent" DECIMAL(5,2),
    "lowestCompetitorPrice" DECIMAL(10,2),
    "competitorFetchedAt" TIMESTAMP(3),
    "feeFetchedAt" TIMESTAMP(3),
    "bestOfferFloor" DECIMAL(10,2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "channelConnectionId" TEXT,
    "aliasId" TEXT,
    "aliasKey" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ChannelListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductListingAlias" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "channelConnectionId" TEXT,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "adoptedFromProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductListingAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelListingSnapshot" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "publishEventId" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'UNACCEPTED',
    "acceptedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "label" TEXT,
    "capturedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,

    CONSTRAINT "ChannelListingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Marketplace" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplaceId" TEXT,
    "region" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "domainUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "vatRate" DECIMAL(5,2),
    "taxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "fbaProgram" TEXT,
    "isParticipating" BOOLEAN NOT NULL DEFAULT false,
    "participationStatus" TEXT,
    "participationCheckedAt" TIMESTAMP(3),
    "schemaMapping" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Marketplace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelListingOverride" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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

-- CreateTable
CREATE TABLE "FieldLinkGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "parentage" "FieldParentage" NOT NULL DEFAULT 'PARENT',
    "variantId" TEXT,
    "translatePolicy" "FieldTranslatePolicy" NOT NULL DEFAULT 'TRANSLATE',
    "members" JSONB NOT NULL DEFAULT '[]',
    "sourceLanguage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldLinkGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldValueMap" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT '*',
    "attribute" TEXT NOT NULL,
    "fromValue" TEXT NOT NULL,
    "toValue" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'MANUAL',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldValueMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeScaleMap" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scale" TEXT NOT NULL,
    "fromSystem" TEXT NOT NULL,
    "toSystem" TEXT NOT NULL,
    "fromValue" TEXT NOT NULL,
    "toValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SizeScaleMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MappingRevision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MappingRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncAttempt" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonSuppression" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "reasonCode" TEXT,
    "reasonText" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingIssue" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "message" TEXT NOT NULL,
    "attributeNames" TEXT[],
    "categories" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'listings-api',
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3),

    CONSTRAINT "ListingIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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

-- CreateTable
CREATE TABLE "ListingRecoveryEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldAsin" TEXT,
    "newAsin" TEXT,
    "oldSku" TEXT,
    "newSku" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "amazonSubmissionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "initiatedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "ListingRecoveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelListingImage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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

-- CreateTable
CREATE TABLE "ProductImage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "type" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "publicId" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "contentHash" TEXT,
    "perceptualHash" TEXT,
    "dhash256" TEXT,
    "derivedFromImageId" TEXT,
    "sameAsImageId" TEXT,
    "distinctFromIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiAnalyzedAt" TIMESTAMP(3),
    "aiHasWhiteBackground" BOOLEAN,
    "aiFrameFillPct" INTEGER,
    "aiHasTextOverlay" BOOLEAN,
    "aiOffCenterScore" DOUBLE PRECISION,
    "aiNotes" JSONB,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "mediaType" TEXT NOT NULL DEFAULT 'IMAGE',
    "posterUrl" TEXT,
    "durationSec" DOUBLE PRECISION,
    "sourceAssetId" TEXT,
    "languageTag" TEXT NOT NULL DEFAULT 'zxx',
    "versionGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMediaPlan" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT '',
    "marketplace" TEXT NOT NULL DEFAULT '',
    "channelConnectionId" TEXT NOT NULL DEFAULT '',
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "plan" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMediaPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminologyPreference" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "brand" TEXT,
    "marketplace" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "preferred" TEXT NOT NULL,
    "avoid" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "context" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminologyPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandVoice" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "brand" TEXT,
    "marketplace" TEXT,
    "language" TEXT,
    "body" TEXT NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "BrandVoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceSync" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "lastSyncStatus" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "channelId" TEXT NOT NULL,
    "channelPrice" DECIMAL(10,2) NOT NULL,
    "stockBuffer" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftListing" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ebayTitle" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "itemSpecifics" JSONB NOT NULL,
    "htmlDescription" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FBAShipment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantitySent" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FBAShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "minMarginPercent" DECIMAL(5,2),
    "maxMarginPercent" DECIMAL(5,2),
    "parameters" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRuleProduct" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "PricingRuleProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRuleVariation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "variationId" TEXT NOT NULL,

    CONSTRAINT "PricingRuleVariation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncHealthLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SyncHealthLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkActionJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
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
    "estimatedCompletionAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkActionItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "productId" TEXT,
    "variationId" TEXT,
    "channelListingId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "BulkActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerFeedback" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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
    "marketplace" TEXT,
    "externalCampaignId" TEXT,
    "portfolioId" TEXT,
    "dailyBudgetCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "biddingStrategy" "BiddingStrategy" NOT NULL DEFAULT 'LEGACY_FOR_SALES',
    "acos" DECIMAL(8,4),
    "roas" DECIMAL(8,4),
    "trueProfitCents" INTEGER,
    "trueProfitMarginPct" DECIMAL(8,4),
    "bidsSuppressedAt" TIMESTAMP(3),
    "bidsSuppressedFloorCents" INTEGER,
    "bidsSuppressedBy" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" "AdSyncStatus",
    "lastSyncError" TEXT,
    "settingsSyncedAt" TIMESTAMP(3),
    "adProduct" TEXT,
    "targetingType" TEXT,
    "budgetJson" JSONB,
    "bidStrategyJson" JSONB,
    "dynamicBidding" JSONB,
    "tactic" TEXT,
    "deliveryProfile" TEXT,
    "costType" TEXT,
    "creativeAssetJson" JSONB,
    "brandEntityId" TEXT,
    "budgetScope" TEXT NOT NULL DEFAULT 'SINGLE_MARKETPLACE',
    "linkedMarketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliveryStatus" TEXT,
    "deliveryReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "liveBidWritesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "liveBidWritesToday" INTEGER NOT NULL DEFAULT 0,
    "liveBidWritesDay" TEXT,
    "minBidCents" INTEGER,
    "maxBidCents" INTEGER,
    "targetAcosPct" INTEGER,
    "budgetBaselineCents" INTEGER,
    "minBudgetCents" INTEGER,
    "maxBudgetCents" INTEGER,
    "pinPlacement" BOOLEAN NOT NULL DEFAULT false,
    "pinBids" BOOLEAN NOT NULL DEFAULT false,
    "pinBudget" BOOLEAN NOT NULL DEFAULT false,
    "pinnedAt" TIMESTAMP(3),
    "pinnedBy" TEXT,
    "pinNote" TEXT,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalAdGroupId" TEXT,
    "name" TEXT NOT NULL,
    "defaultBidCents" INTEGER NOT NULL DEFAULT 50,
    "suppressedFromBidCents" INTEGER,
    "baseBidFromCents" INTEGER,
    "status" "CampaignStatus" NOT NULL DEFAULT 'ENABLED',
    "targetingType" TEXT NOT NULL DEFAULT 'MANUAL',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" "AdSyncStatus",
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bidStrategyJson" JSONB,
    "creativeType" TEXT,
    "deliveryStatus" TEXT,
    "deliveryReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "orphanedAt" TIMESTAMP(3),
    "orphanReason" TEXT,

    CONSTRAINT "AdGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdTarget" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "externalTargetId" TEXT,
    "kind" TEXT NOT NULL,
    "expressionType" TEXT NOT NULL,
    "expressionValue" TEXT NOT NULL,
    "bidCents" INTEGER NOT NULL DEFAULT 50,
    "suppressedFromBidCents" INTEGER,
    "baseBidFromCents" INTEGER,
    "status" "CampaignStatus" NOT NULL DEFAULT 'ENABLED',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" "AdSyncStatus",
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isNegative" BOOLEAN NOT NULL DEFAULT false,
    "negativeLevel" TEXT,
    "deliveryStatus" TEXT,
    "deliveryReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "orphanedAt" TIMESTAMP(3),
    "orphanReason" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retireReason" TEXT,

    CONSTRAINT "AdTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdProductAd" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "productId" TEXT,
    "asin" TEXT,
    "sku" TEXT,
    "externalAdId" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'ENABLED',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "creativeJson" JSONB,
    "adType" TEXT,
    "deliveryStatus" TEXT,
    "deliveryReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "AdProductAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdProductSet" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'AMAZON',
    "marketplace" TEXT NOT NULL,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdProductSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsConnection" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'EU',
    "accountLabel" TEXT,
    "credentialsEncrypted" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'sandbox',
    "writesEnabledAt" TIMESTAMP(3),
    "lastWriteAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "tokenIssuedAt" TIMESTAMP(3),
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenIssuedAtIsEstimate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonAdsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsProfile" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'EU',
    "countryCode" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "timezone" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'seller',
    "accountEntityId" TEXT,
    "accountName" TEXT,
    "validPaymentMethod" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "lastProfileFetchAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonAdsProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordWatchlist" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordWatchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordWatchlistTerm" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "isBranded" BOOLEAN NOT NULL DEFAULT false,
    "addedFrom" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeywordWatchlistTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordCoverageSet" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dailySpendCapCents" INTEGER,
    "acosCapPct" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "KeywordCoverageSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordCoverageTerm" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "leadAsin" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "maxCpcCents" INTEGER,
    "targetSharePct" DECIMAL(6,2),
    "isControl" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordCoverageTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsPortfolio" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "externalPortfolioId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT,
    "budgetAmount" DECIMAL(12,2),
    "budgetCurrencyCode" TEXT,
    "budgetPolicy" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "inBudget" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonAdsPortfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsDailyPerformance" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "localEntityId" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "sales1dCents" INTEGER DEFAULT 0,
    "sales7dCents" INTEGER DEFAULT 0,
    "sales14dCents" INTEGER DEFAULT 0,
    "sales30dCents" INTEGER DEFAULT 0,
    "orders7d" INTEGER DEFAULT 0,
    "units7d" INTEGER DEFAULT 0,
    "orders1d" INTEGER,
    "orders14d" INTEGER,
    "orders30d" INTEGER,
    "units1d" INTEGER,
    "units14d" INTEGER,
    "units30d" INTEGER,
    "salesSameSku1dCents" INTEGER,
    "salesSameSku7dCents" INTEGER,
    "salesSameSku14dCents" INTEGER,
    "salesSameSku30dCents" INTEGER,
    "ordersSameSku1d" INTEGER,
    "ordersSameSku7d" INTEGER,
    "ordersSameSku14d" INTEGER,
    "ordersSameSku30d" INTEGER,
    "unitsSameSku1d" INTEGER,
    "unitsSameSku7d" INTEGER,
    "unitsSameSku14d" INTEGER,
    "unitsSameSku30d" INTEGER,
    "topOfSearchIS" DECIMAL(8,4),
    "campaignBudgetCents" INTEGER,
    "campaignBudgetType" TEXT,
    "campaignBiddingStrategy" TEXT,
    "campaignRuleBasedBudgetCents" INTEGER,
    "campaignBudgetRuleId" TEXT,
    "campaignBudgetRuleName" TEXT,
    "entityName" TEXT,
    "entityStatus" TEXT,
    "ntbOrders14d" INTEGER DEFAULT 0,
    "ntbSalesCents14d" INTEGER DEFAULT 0,
    "ntbUnits14d" INTEGER,
    "ntbOrdersRate14d" DOUBLE PRECISION,
    "viewableImpressions" INTEGER DEFAULT 0,
    "detailPageViews7d" INTEGER DEFAULT 0,
    "kenpRead14d" INTEGER,
    "kenpRoyaltiesCents14d" INTEGER,
    "acos7d" DECIMAL(8,4),
    "roas7d" DECIMAL(8,4),
    "reportRunId" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsDailyPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsHourlyPerformance" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "localEntityId" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "sales7dCents" INTEGER DEFAULT 0,
    "orders7d" INTEGER DEFAULT 0,
    "units7d" INTEGER DEFAULT 0,
    "reportRunId" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsHourlyPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdBudgetUsageSample" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalCampaignId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "percent" DOUBLE PRECISION NOT NULL,
    "budgetCents" INTEGER,
    "usageUpdatedAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'pull',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdBudgetUsageSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsSearchTerm" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "matchedKeywordId" TEXT,
    "matchedTargetId" TEXT,
    "matchType" TEXT,
    "query" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "sales7dCents" INTEGER DEFAULT 0,
    "orders7d" INTEGER DEFAULT 0,
    "reportRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsSearchTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchQueryPerformance" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "reportPeriod" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "searchQuery" TEXT NOT NULL,
    "asin" TEXT,
    "searchQueryVolume" INTEGER NOT NULL DEFAULT 0,
    "searchQueryRank" INTEGER,
    "impressionsTotal" INTEGER NOT NULL DEFAULT 0,
    "impressionsBrand" INTEGER NOT NULL DEFAULT 0,
    "impressionShare" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "clicksTotal" INTEGER NOT NULL DEFAULT 0,
    "clicksBrand" INTEGER NOT NULL DEFAULT 0,
    "clickShare" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "cartAddsTotal" INTEGER NOT NULL DEFAULT 0,
    "cartAddsBrand" INTEGER NOT NULL DEFAULT 0,
    "cartAddShare" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "purchasesTotal" INTEGER NOT NULL DEFAULT 0,
    "purchasesBrand" INTEGER NOT NULL DEFAULT 0,
    "purchaseShare" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "sourceReportId" TEXT,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchQueryPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsPlacementReport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "campaignId" TEXT NOT NULL,
    "localCampaignId" TEXT,
    "placement" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "sales7dCents" INTEGER DEFAULT 0,
    "orders7d" INTEGER DEFAULT 0,
    "topOfSearchIS" DECIMAL(8,4),
    "reportRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsPlacementReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataKioskQueryJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "queryType" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "externalQueryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dataDocumentId" TEXT,
    "errorDocumentId" TEXT,
    "query" TEXT NOT NULL,
    "rowsIngested" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataKioskQueryJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonEconomicsDaily" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "parentAsin" TEXT NOT NULL,
    "childAsin" TEXT NOT NULL,
    "msku" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "unitsOrdered" INTEGER NOT NULL DEFAULT 0,
    "netProductSales" DECIMAL(14,2),
    "averageSellingPrice" DECIMAL(14,2),
    "netProceedsTotal" DECIMAL(14,2),
    "netProceedsPerUnit" DECIMAL(14,2),
    "feesTotal" DECIMAL(14,2),
    "feesCount" INTEGER NOT NULL DEFAULT 0,
    "adsTotal" DECIMAL(14,2),
    "adsCount" INTEGER NOT NULL DEFAULT 0,
    "costOfGoodsSold" DECIMAL(14,2),
    "miscellaneousCost" DECIMAL(14,2),
    "raw" JSONB NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonEconomicsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsBrandMetric" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "searchImpressionShare" DECIMAL(8,4),
    "brandSearches" BIGINT,
    "brandConversionShare" DECIMAL(8,4),
    "categoryRank" INTEGER,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsBrandMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsBrandBuildingMetric" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "brandId" TEXT,
    "computationDate" DATE NOT NULL,
    "lookbackPeriod" TEXT NOT NULL DEFAULT '1w',
    "categoryNodeName" TEXT NOT NULL DEFAULT '',
    "categoryNodeTreeName" TEXT,
    "metrics" JSONB NOT NULL,
    "awarenessIndex" DECIMAL(12,4),
    "considerationIndex" DECIMAL(12,4),
    "salesIndex" DECIMAL(12,4),
    "brandCustomers" INTEGER,
    "highValueCustomers" INTEGER,
    "addToCarts" INTEGER,
    "viewedDetailPageOnly" INTEGER,
    "brandedSearchesOnly" INTEGER,
    "brandedSearchesAndDetailPageViews" INTEGER,
    "newToBrandCustomerRate" DECIMAL(12,4),
    "customerConversionRate" DECIMAL(12,4),
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonAdsBrandBuildingMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsReportJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "reportTypeId" TEXT NOT NULL,
    "externalReportId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "configuration" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "location" TEXT,
    "fileSize" INTEGER,
    "rowsIngested" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3),

    CONSTRAINT "AmazonAdsReportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsExportJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "adProducts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalExportId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "url" TEXT,
    "urlExpiresAt" TIMESTAMP(3),
    "fileSize" INTEGER,
    "rowsIngested" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "configuration" JSONB NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AmazonAdsExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaStorageAge" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "marketplace" TEXT NOT NULL,
    "polledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantityInAge0_90" INTEGER NOT NULL DEFAULT 0,
    "quantityInAge91_180" INTEGER NOT NULL DEFAULT 0,
    "quantityInAge181_270" INTEGER NOT NULL DEFAULT 0,
    "quantityInAge271_365" INTEGER NOT NULL DEFAULT 0,
    "quantityInAge365Plus" INTEGER NOT NULL DEFAULT 0,
    "projectedLtsFee30dCents" INTEGER NOT NULL DEFAULT 0,
    "projectedLtsFee60dCents" INTEGER NOT NULL DEFAULT 0,
    "projectedLtsFee90dCents" INTEGER NOT NULL DEFAULT 0,
    "currentStorageFeeCents" INTEGER NOT NULL DEFAULT 0,
    "daysToLtsThreshold" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FbaStorageAge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductProfitDaily" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "grossRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "cogsCents" INTEGER NOT NULL DEFAULT 0,
    "referralFeesCents" INTEGER NOT NULL DEFAULT 0,
    "fbaFulfillmentFeesCents" INTEGER NOT NULL DEFAULT 0,
    "fbaStorageFeesCents" INTEGER NOT NULL DEFAULT 0,
    "advertisingSpendCents" INTEGER NOT NULL DEFAULT 0,
    "returnsRefundsCents" INTEGER NOT NULL DEFAULT 0,
    "otherFeesCents" INTEGER NOT NULL DEFAULT 0,
    "trueProfitCents" INTEGER,
    "trueProfitMarginPct" DECIMAL(8,4),
    "coverage" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductProfitDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdDrift" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalId" TEXT,
    "marketplace" TEXT,
    "entityName" TEXT,
    "field" TEXT NOT NULL,
    "ourValue" TEXT,
    "amazonValue" TEXT,
    "classification" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AdDrift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertisingActionLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "executionId" TEXT,
    "userId" TEXT,
    "actionType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadBefore" JSONB NOT NULL,
    "payloadAfter" JSONB NOT NULL,
    "outboundQueueId" TEXT,
    "amazonResponseId" TEXT,
    "amazonResponseStatus" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" TEXT,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvertisingActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetPool" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "totalDailyBudgetCents" INTEGER NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'STATIC',
    "coolDownMinutes" INTEGER NOT NULL DEFAULT 60,
    "maxShiftPerRebalancePct" INTEGER NOT NULL DEFAULT 20,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "lastRebalancedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "BudgetPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetPoolAllocation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "budgetPoolId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "campaignId" TEXT,
    "targetSharePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "minDailyBudgetCents" INTEGER NOT NULL DEFAULT 100,
    "maxDailyBudgetCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetPoolAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetPoolRebalance" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "budgetPoolId" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "outputs" JSONB NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "totalShiftCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetPoolRebalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBidHistory" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "campaignId" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "CampaignBidHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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

-- CreateTable
CREATE TABLE "AccountSettings" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL DEFAULT '',
    "addressLine1" TEXT NOT NULL DEFAULT '',
    "addressLine2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT 'US',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "primaryMarketplace" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "eventType" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "sms" BOOLEAN NOT NULL DEFAULT false,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "channelFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "digestCadence" TEXT NOT NULL DEFAULT 'instant',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationWebhook" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "lastUsed" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "rotatedToId" TEXT,
    "rotationGraceUntil" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "avatarUrl" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT NOT NULL DEFAULT '',
    "phone" TEXT,
    "timezone" TEXT,
    "language" TEXT,
    "dateFormat" TEXT,
    "weekStart" INTEGER,
    "workingHoursStart" TEXT,
    "workingHoursEnd" TEXT,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "twoFactorSecret" TEXT,
    "twoFactorEnabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deactivatedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "permissionsVersion" INTEGER NOT NULL DEFAULT 0,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataRetentionPolicy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "policies" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataRetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataExportRequest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "format" TEXT NOT NULL DEFAULT 'json',
    "scope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "downloadUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "bytes" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataExportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "ipCity" TEXT,
    "ipCountry" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "sessionTokenHash" TEXT,
    "idleExpiry" TIMESTAMP(3),
    "absoluteExpiry" TIMESTAMP(3),
    "mfaSatisfied" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "emailTried" TEXT,
    "outcome" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "ipCity" TEXT,
    "ipCountry" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "workspaceId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "requireMfa" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "channelScope" JSONB,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "channelScope" JSONB,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandReceipt" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "actorUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "httpStatus" INTEGER,
    "response" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerTimestamp" TIMESTAMP(3),
    "connectionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveries" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "processingToken" TEXT,
    "processingUntil" TIMESTAMP(3),
    "rawBody" BYTEA,
    "verificationHeaders" JSONB,
    "signatureOk" BOOLEAN,
    "verifiedBy" TEXT,
    "payloadDigest" TEXT,
    "lastError" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archiveUri" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayNoticeQuarantine" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "signatureOk" BOOLEAN NOT NULL DEFAULT false,
    "externalId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "subjectHash" TEXT,
    "firstOwnerWorkspaceId" TEXT,
    "payloadEnc" TEXT,
    "payloadKeyId" TEXT,
    "payloadDigest" TEXT NOT NULL,
    "verificationKeyId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveries" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "resolvedWorkspaceId" TEXT,
    "resolvedReceiptId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "reviewAttempts" INTEGER NOT NULL DEFAULT 0,
    "reviewNextAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewOutcome" TEXT,

    CONSTRAINT "EbayNoticeQuarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErasureRequest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "quarantineId" TEXT,
    "evidenceOrderId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'EBAY',
    "environment" TEXT NOT NULL,
    "matchBasis" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ErasureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayQuarantineMaintenanceAudit" (
    "operationId" UUID NOT NULL,
    "quarantineId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionUser" TEXT NOT NULL,
    "oldKeyId" TEXT NOT NULL,
    "newKeyId" TEXT NOT NULL,
    "oldCipherDigest" TEXT NOT NULL,
    "newCipherDigest" TEXT NOT NULL,

    CONSTRAINT "EbayQuarantineMaintenanceAudit_pkey" PRIMARY KEY ("operationId","quarantineId")
);

-- CreateTable
CREATE TABLE "ChannelLiveImage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "externalSku" TEXT,
    "asin" TEXT,
    "slot" TEXT,
    "url" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "etag" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelLiveImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelStockEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channelEventId" TEXT NOT NULL,
    "productId" TEXT,
    "variationId" TEXT,
    "sku" TEXT NOT NULL,
    "locationId" TEXT,
    "channelReportedQty" INTEGER NOT NULL,
    "localQtyAtObservation" INTEGER NOT NULL,
    "drift" INTEGER NOT NULL,
    "status" "ChannelStockEventStatus" NOT NULL DEFAULT 'PENDING',
    "resolution" TEXT,
    "resultingMovementId" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelStockEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsSuccessful" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncError" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" "OrderChannel" NOT NULL,
    "marketplace" TEXT,
    "channelOrderId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT DEFAULT 'EUR',
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerId" TEXT,
    "shippingAddress" JSONB NOT NULL,
    "codiceFiscale" TEXT,
    "partitaIva" TEXT,
    "fiscalKind" TEXT,
    "pecEmail" TEXT,
    "codiceDestinatario" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "deliveredAtSource" TEXT,
    "fulfillmentMethod" TEXT,
    "shipByDate" TIMESTAMP(3),
    "earliestShipDate" TIMESTAMP(3),
    "latestDeliveryDate" TIMESTAMP(3),
    "fulfillmentLatency" INTEGER,
    "isPrime" BOOLEAN,
    "amazonMetadata" JSONB,
    "ebayMetadata" JSONB,
    "shopifyMetadata" JSONB,
    "woocommerceMetadata" JSONB,
    "etsyMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "channelConnectionId" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "codiceFiscale" TEXT,
    "partitaIva" TEXT,
    "fiscalKind" TEXT,
    "pecEmail" TEXT,
    "codiceDestinatario" TEXT,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalSpentCents" BIGINT NOT NULL DEFAULT 0,
    "firstOrderAt" TIMESTAMP(3),
    "lastOrderAt" TIMESTAMP(3),
    "channelOrderCounts" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskFlag" TEXT,
    "manualReviewState" TEXT,
    "lastRiskComputedAt" TIMESTAMP(3),
    "rfmScore" TEXT,
    "rfmLabel" TEXT,
    "rfmComputedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSegment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "customerCount" INTEGER NOT NULL DEFAULT 0,
    "lastCountedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "recipient" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "phone" TEXT,
    "source" TEXT,
    "channelOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerNote" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorEmail" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalInvoiceCounter" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "fiscalYear" INTEGER NOT NULL,
    "issuer" TEXT NOT NULL DEFAULT 'XAVIA',
    "current" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalInvoiceCounter_pkey" PRIMARY KEY ("fiscalYear","issuer")
);

-- CreateTable
CREATE TABLE "FiscalInvoice" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL DEFAULT 'XAVIA',
    "fiscalYear" INTEGER NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "sdiTransmissionId" TEXT,
    "sdiStatus" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteCounter" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "fiscalYear" INTEGER NOT NULL,
    "issuer" TEXT NOT NULL DEFAULT 'XAVIA',
    "current" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteCounter_pkey" PRIMARY KEY ("fiscalYear","issuer")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "originalInvoiceId" TEXT,
    "issuer" TEXT NOT NULL DEFAULT 'XAVIA',
    "fiscalYear" INTEGER NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "causale" TEXT,
    "sdiTransmissionId" TEXT,
    "sdiStatus" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderNote" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorEmail" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRiskScore" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "flag" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderRiskScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "externalLineItemId" TEXT,
    "itVatRatePct" DECIMAL(5,2),
    "amazonMetadata" JSONB,
    "ebayMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySalesAggregate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "grossRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER,
    "buyBoxPct" DECIMAL(5,2),
    "conversionRate" DECIMAL(5,4),
    "isStockOut" BOOLEAN NOT NULL DEFAULT false,
    "averageSellingPrice" DECIMAL(10,2),
    "source" TEXT NOT NULL DEFAULT 'ORDER_ITEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySalesAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentForecast" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "horizonDay" DATE NOT NULL,
    "forecastUnits" DECIMAL(12,2) NOT NULL,
    "lower80" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "upper80" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL DEFAULT 'HOLT_WINTERS_V1',
    "signals" JSONB NOT NULL DEFAULT '{}',
    "generationTag" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplenishmentForecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastModelAssignment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ForecastModelAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastAccuracy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "forecastUnits" DECIMAL(12,2) NOT NULL,
    "forecastLower80" DECIMAL(12,2),
    "forecastUpper80" DECIMAL(12,2),
    "actualUnits" INTEGER NOT NULL,
    "absoluteError" DECIMAL(12,2) NOT NULL,
    "percentError" DECIMAL(7,2),
    "withinBand" BOOLEAN NOT NULL,
    "modelRegime" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "forecastGeneratedAt" TIMESTAMP(3) NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastAccuracy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandSettings" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "companyName" TEXT,
    "addressLines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "taxId" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "websiteUrl" TEXT,
    "piva" TEXT,
    "codiceFiscale" TEXT,
    "sdiCode" TEXT,
    "pecEmail" TEXT,
    "vatScheme" TEXT,
    "logoUrl" TEXT,
    "signatureBlockText" TEXT,
    "defaultPoNotes" TEXT,
    "factoryEmailFrom" TEXT,
    "requireApprovalForPo" BOOLEAN NOT NULL DEFAULT false,
    "poApprovalThresholdCents" INTEGER,
    "poApprovalApproverEmail" TEXT,
    "cashOnHandCents" INTEGER,
    "userManualUrls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetailEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "channel" TEXT,
    "marketplace" TEXT,
    "productType" TEXT,
    "expectedLift" DECIMAL(4,2) NOT NULL DEFAULT 1,
    "prepLeadTimeDays" INTEGER NOT NULL DEFAULT 30,
    "description" TEXT,
    "source" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingSnapshot" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "fulfillmentMethod" TEXT,
    "computedPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "isClamped" BOOLEAN NOT NULL DEFAULT false,
    "clampedFrom" DECIMAL(12,2),
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceChangeEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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

-- CreateTable
CREATE TABLE "BuyBoxHistory" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buyBoxPrice" DECIMAL(10,2),
    "lowestCompetitorPrice" DECIMAL(10,2),
    "isOurOffer" BOOLEAN NOT NULL DEFAULT false,
    "winnerSellerId" TEXT,
    "fulfillmentMethod" TEXT,
    "marginAtObservation" DECIMAL(8,4),

    CONSTRAINT "BuyBoxHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxRate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DECIMAL(14,8) NOT NULL,
    "asOf" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'frankfurter',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetailEventPriceAction" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "channel" TEXT,
    "marketplace" TEXT,
    "productType" TEXT,
    "action" TEXT NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "setSalePriceFrom" TIMESTAMP(3),
    "setSalePriceUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetailEventPriceAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementReport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "documentId" TEXT,
    "reportType" TEXT NOT NULL DEFAULT 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    "marketplaceId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "depositDate" TIMESTAMP(3),
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "rawBody" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'INGESTED',
    "reconcileNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialTransaction" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "amazonTransactionId" TEXT,
    "ebayTransactionId" TEXT,
    "orderId" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "amazonFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fbaFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentServicesFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "ebayFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paypalFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "otherFees" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "grossRevenue" DECIMAL(12,2) NOT NULL,
    "netRevenue" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "amazonMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "marketplace" TEXT,
    "managedBy" TEXT NOT NULL DEFAULT 'oauth',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "displayName" TEXT,
    "ebayAccessToken" TEXT,
    "ebayRefreshToken" TEXT,
    "ebayTokenExpiresAt" TIMESTAMP(3),
    "ebayDevId" TEXT,
    "ebayAppId" TEXT,
    "ebaySignInName" TEXT,
    "ebayStoreName" TEXT,
    "ebayStoreFrontUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "accountLabel" TEXT,
    "accountColor" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "externalAccountId" TEXT,
    "connectionMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "authStatus" TEXT NOT NULL DEFAULT 'unknown',
    "region" TEXT,
    "credentialsEnc" TEXT,
    "credentialsKeyId" TEXT,
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "lastRefreshAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "refreshLeaseUntil" TIMESTAMP(3),
    "refreshLeaseOwner" TEXT,
    "grantVersion" INTEGER NOT NULL DEFAULT 0,
    "identity" JSONB,
    "apiVersion" TEXT,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionScope" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "region" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectionScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelApp" (
    "id" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT,
    "redirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extra" JSONB,
    "signingKeyEnc" TEXT,
    "signingKeyId" TEXT,
    "signingKeyExpiresAt" TIMESTAMP(3),
    "signingKeyCheckedAt" TIMESTAMP(3),
    "secretExpiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthSession" (
    "workspaceId" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "id" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "targetConnectionId" TEXT,
    "startedByUserId" TEXT,
    "codeVerifier" TEXT,
    "redirectUri" TEXT NOT NULL,
    "cookieNonce" TEXT NOT NULL,
    "region" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "resultConnectionId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT,
    "channelKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" TEXT,
    "detail" JSONB,
    "archivedRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundSyncQueue" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
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
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "holdUntil" TIMESTAMP(3),
    "syncType" TEXT NOT NULL,
    "externalListingId" TEXT,
    "channelConnectionId" TEXT,
    "isDead" BOOLEAN NOT NULL DEFAULT false,
    "diedAt" TIMESTAMP(3),

    CONSTRAINT "OutboundSyncQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkOperation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "productCount" INTEGER NOT NULL,
    "changeCount" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "errors" JSONB,
    "cascadeCount" INTEGER NOT NULL DEFAULT 0,
    "affectedChildren" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "uploadFilename" TEXT,
    "processed" INTEGER,
    "total" INTEGER,
    "expectedVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkOpsTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT,
    "columnIds" TEXT[],
    "filterState" JSONB,
    "enabledChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabledProductTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collapsedGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkOpsTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkActionTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "actionType" TEXT NOT NULL,
    "channel" TEXT,
    "actionPayload" JSONB NOT NULL DEFAULT '{}',
    "defaultFilters" JSONB,
    "parameters" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT,
    "userId" TEXT,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT false,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledBulkAction" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "actionType" TEXT NOT NULL,
    "channel" TEXT,
    "actionPayload" JSONB NOT NULL DEFAULT '{}',
    "targetProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetVariationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "filters" JSONB,
    "scheduledFor" TIMESTAMP(3),
    "cronExpression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "nextRunAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastJobId" TEXT,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "templateId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledBulkAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkAutomationApproval" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "triggerPayload" JSONB NOT NULL,
    "actionPlan" JSONB NOT NULL,
    "threshold" TEXT NOT NULL,
    "estimatedValueCentsEur" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "resolvedActionResults" JSONB,
    "resolvedExecutionId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkAutomationApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlatFileImport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "markets" JSONB NOT NULL,
    "includeMaster" BOOLEAN NOT NULL DEFAULT false,
    "snapshotId" TEXT,
    "filename" TEXT,
    "uploadHandle" TEXT,
    "reportHandle" TEXT,
    "diff" JSONB,
    "inverseDiff" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "rolledBackAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlatFileImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "sourceUrl" TEXT,
    "filename" TEXT,
    "fileKind" TEXT NOT NULL,
    "targetEntity" TEXT NOT NULL,
    "columnMapping" JSONB NOT NULL DEFAULT '{}',
    "onError" TEXT NOT NULL DEFAULT 'skip',
    "status" TEXT NOT NULL DEFAULT 'PENDING_PREVIEW',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "successRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "planToken" TEXT,
    "planComputedAt" TIMESTAMP(3),
    "planSummary" JSONB,
    "scheduleId" TEXT,
    "parentJobId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJobRow" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "targetId" TEXT,
    "parsedValues" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportJobRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledImport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "targetEntity" TEXT NOT NULL,
    "columnMapping" JSONB NOT NULL DEFAULT '{}',
    "onError" TEXT NOT NULL DEFAULT 'skip',
    "cronExpression" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "nextRunAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastJobId" TEXT,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "description" TEXT,
    "format" TEXT NOT NULL,
    "targetEntity" TEXT NOT NULL,
    "columns" JSONB NOT NULL DEFAULT '[]',
    "filters" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "artifactBase64" TEXT,
    "artifactUrl" TEXT,
    "snapshotId" TEXT,
    "marketList" JSONB,
    "errorMessage" TEXT,
    "scheduleId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledExport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "format" TEXT NOT NULL,
    "targetEntity" TEXT NOT NULL,
    "columns" JSONB NOT NULL DEFAULT '[]',
    "filters" JSONB,
    "delivery" TEXT NOT NULL DEFAULT 'email',
    "deliveryTarget" TEXT,
    "cronExpression" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "nextRunAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastJobId" TEXT,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceTaxonomy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "activeSnapshotId" TEXT,
    "requestVersion" INTEGER NOT NULL DEFAULT 0,
    "completedRequestVersion" INTEGER NOT NULL DEFAULT 0,
    "schemaRequests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceTaxonomy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceTaxonomySnapshot" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerVersion" TEXT,
    "contentHash" TEXT,
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "removedCount" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MarketplaceTaxonomySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceTaxonomyNode" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "assignable" BOOLEAN NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "MarketplaceTaxonomyNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategorySchema" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "productType" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "schemaDefinition" JSONB NOT NULL,
    "variationThemes" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CategorySchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GtinExemptionApplication" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "productIds" TEXT[],
    "marketplace" TEXT NOT NULL,
    "productType" TEXT,
    "brandRegistrationType" TEXT NOT NULL,
    "trademarkNumber" TEXT,
    "trademarkCountry" TEXT,
    "trademarkDate" TIMESTAMP(3),
    "trademarkCertUrl" TEXT,
    "brandWebsite" TEXT,
    "brandLetter" TEXT NOT NULL,
    "brandLetterCustomised" BOOLEAN NOT NULL DEFAULT false,
    "imagesProvided" TEXT[],
    "imageValidation" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "amazonCaseId" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packageGeneratedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GtinExemptionApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingWizard" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channels" JSONB NOT NULL,
    "channelsHash" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL DEFAULT '{}',
    "channelStates" JSONB NOT NULL DEFAULT '{}',
    "submissions" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ListingWizard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledImagePublish" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "firedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "fireResult" JSONB,
    "fireError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "ScheduledImagePublish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledWizardPublish" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "wizardId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "firedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "fireResult" JSONB,
    "fireError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "ScheduledWizardPublish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WizardStepEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "wizardId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorContext" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WizardStepEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WizardTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channels" JSONB NOT NULL,
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "categoryHint" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "WizardTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "workspaceId" TEXT DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "ip" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APlusContent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "marketplace" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "masterContentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "amazonDocumentId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submissionPayload" JSONB,
    "publishedAt" TIMESTAMP(3),
    "notes" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "APlusContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APlusContentVersion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "APlusContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APlusContentAsin" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "contentId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "productId" TEXT,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "APlusContentAsin_pkey" PRIMARY KEY ("contentId","asin")
);

-- CreateTable
CREATE TABLE "APlusModule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "APlusModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandStory" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "masterStoryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "amazonDocumentId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submissionPayload" JSONB,
    "publishedAt" TIMESTAMP(3),
    "notes" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandStory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandStoryModule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandStoryModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandStoryVersion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandStoryVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandKit" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "displayName" TEXT,
    "tagline" TEXT,
    "voiceNotes" TEXT,
    "colors" JSONB NOT NULL DEFAULT '[]',
    "fonts" JSONB NOT NULL DEFAULT '[]',
    "logos" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandWatermarkTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandWatermarkTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetLocaleOverlay" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" TEXT NOT NULL DEFAULT 'south',
    "color" TEXT NOT NULL DEFAULT 'white',
    "bgColor" TEXT,
    "font" TEXT NOT NULL DEFAULT 'Arial_60_bold',
    "offsetY" INTEGER NOT NULL DEFAULT 24,
    "offsetX" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetLocaleOverlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingImage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variationId" TEXT,
    "scope" "ImageScope" NOT NULL DEFAULT 'GLOBAL',
    "platform" TEXT,
    "marketplace" TEXT,
    "url" TEXT NOT NULL,
    "filename" TEXT,
    "position" INTEGER NOT NULL,
    "role" "ImageRole" NOT NULL DEFAULT 'GALLERY',
    "width" INTEGER,
    "height" INTEGER,
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "hasWhiteBackground" BOOLEAN,
    "sourceProductImageId" TEXT,
    "altOverride" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT,
    "amazonSlot" TEXT,
    "variantGroupKey" TEXT,
    "variantGroupValue" TEXT,
    "publishStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishError" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "mediaType" TEXT NOT NULL DEFAULT 'IMAGE',
    "posterUrl" TEXT,
    "durationSec" DOUBLE PRECISION,
    "sourceAssetId" TEXT,

    CONSTRAINT "ListingImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonMediaRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REVIEW',
    "plan" JSONB NOT NULL,
    "receipts" JSONB NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonMediaRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonImageFeedJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "feedId" TEXT,
    "feedDocumentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skus" JSONB NOT NULL,
    "errorMessage" TEXT,
    "resultSummary" JSONB,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AmazonImageFeedJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonFlatFileFeedJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "feedDocumentId" TEXT,
    "marketplace" TEXT NOT NULL,
    "productType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_QUEUE',
    "skuCount" INTEGER NOT NULL DEFAULT 0,
    "skus" JSONB,
    "resultSummary" JSONB,
    "perSkuResults" JSONB,
    "errorMessage" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AmazonFlatFileFeedJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayPushJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "taskId" TEXT,
    "markets" JSONB,
    "skuCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "pushed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "perSkuResults" JSONB,
    "warnings" JSONB,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EbayPushJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelImagePublishJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTING',
    "errorMessage" TEXT,
    "requestPayload" JSONB,
    "response" JSONB,
    "vendorEntityId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ChannelImagePublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemaChange" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "productType" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "affectedProducts" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "SchemaChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IT',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "kind" TEXT,
    "sendcloudSenderId" INTEGER,
    "sharedFromLocationId" TEXT,
    "defaultCarrierAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "servesMarketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncRoutes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalLocationId" TEXT,
    "externalChannel" TEXT,
    "warehouseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variationId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "reorderThreshold" INTEGER,
    "reorderQuantity" INTEGER,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'SYNCED',
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "stockLevelId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "orderId" TEXT,
    "reason" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'HARD',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "poolGrantId" TEXT,
    "consumerWorkspaceId" TEXT,
    "consumerOrderRef" TEXT,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variationId" TEXT,
    "warehouseId" TEXT,
    "change" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" "StockMovementReason" NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "notes" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locationId" TEXT,
    "fromLocationId" TEXT,
    "toLocationId" TEXT,
    "quantityBefore" INTEGER,
    "orderId" TEXT,
    "shipmentId" TEXT,
    "returnId" TEXT,
    "reservationId" TEXT,
    "cogsCents" INTEGER,
    "lotId" TEXT,
    "serialNumberId" TEXT,
    "binId" TEXT,
    "poolGrantId" TEXT,
    "consumerWorkspaceId" TEXT,
    "consumerOrderRef" TEXT,
    "poolSettledAt" TIMESTAMP(3),

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCostLayer" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variationId" TEXT,
    "locationId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unitCost" DECIMAL(12,4) NOT NULL,
    "unitsReceived" INTEGER NOT NULL,
    "unitsRemaining" INTEGER NOT NULL,
    "freightCents" INTEGER,
    "dutyCents" INTEGER,
    "insuranceCents" INTEGER,
    "brokerCents" INTEGER,
    "costCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "exchangeRateOnReceive" DECIMAL(14,8),
    "unitCostVatExcluded" BOOLEAN NOT NULL DEFAULT true,
    "vatRate" DECIMAL(5,4),
    "inboundShipmentId" TEXT,
    "stockMovementId" TEXT,
    "notes" TEXT,
    "lotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCostLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lot" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variationId" TEXT,
    "lotNumber" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "unitsReceived" INTEGER NOT NULL,
    "unitsRemaining" INTEGER NOT NULL,
    "originPoId" TEXT,
    "originInboundShipmentId" TEXT,
    "originStockMovementId" TEXT,
    "supplierLotRef" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerialNumber" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variationId" TEXT,
    "serialNumber" TEXT NOT NULL,
    "lotId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "locationId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "disposedAt" TIMESTAMP(3),
    "currentOrderId" TEXT,
    "currentShipmentId" TEXT,
    "lastReturnId" TEXT,
    "manufacturerRef" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SerialNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBin" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "zone" TEXT,
    "binType" TEXT,
    "capacity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBinQuantity" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "stockLevelId" TEXT NOT NULL,
    "binId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBinQuantity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotRecall" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LotRecall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YearEndSnapshot" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalUnits" INTEGER NOT NULL,
    "totalValueEurCents" INTEGER NOT NULL,
    "layerCount" INTEGER NOT NULL,
    "byLocation" JSONB NOT NULL,
    "byMethod" JSONB NOT NULL,
    "byCurrency" JSONB NOT NULL,
    "vatTreatment" JSONB NOT NULL,
    "notes" TEXT,

    CONSTRAINT "YearEndSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaInventoryDetail" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "marketplaceId" TEXT NOT NULL,
    "fulfillmentCenterId" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "firstReceivedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FbaInventoryDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCFShipment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amazonFulfillmentOrderId" TEXT NOT NULL,
    "sellerFulfillmentOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "marketplaceId" TEXT,
    "displayableOrderId" TEXT,
    "shippingSpeedCategory" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "rawResponse" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCFShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Carrier" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" "CarrierCode" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "credentialsEncrypted" TEXT,
    "defaultServiceMap" JSONB,
    "lastUsedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "accountLabel" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'sandbox',
    "webhookSecret" TEXT,
    "preferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierService" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "carrierSubName" TEXT,
    "tier" TEXT,
    "minWeightG" INTEGER,
    "maxWeightG" INTEGER,
    "countriesJson" JSONB,
    "capabilitiesJson" JSONB,
    "basePriceCents" INTEGER,
    "currencyCode" TEXT DEFAULT 'EUR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierServiceMapping" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'GLOBAL',
    "warehouseId" TEXT,
    "tierOverride" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierServiceMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierMetric" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "shipmentCount" INTEGER NOT NULL DEFAULT 0,
    "totalCostCents" INTEGER NOT NULL DEFAULT 0,
    "avgCostCents" INTEGER,
    "onTimeCount" INTEGER NOT NULL DEFAULT 0,
    "lateCount" INTEGER NOT NULL DEFAULT 0,
    "exceptionCount" INTEGER NOT NULL DEFAULT 0,
    "medianDeliveryHours" DECIMAL(10,2),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickupSchedule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "daysOfWeek" INTEGER,
    "scheduledFor" TIMESTAMP(3),
    "windowStart" TEXT,
    "windowEnd" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "externalRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastDispatchAt" TIMESTAMP(3),
    "lastDispatchErr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PickupSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierAccount" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "accountLabel" TEXT NOT NULL,
    "credentialsEncrypted" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'sandbox',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "warehouseId" TEXT,
    "carrierCode" "CarrierCode" NOT NULL DEFAULT 'SENDCLOUD',
    "status" "ShipmentStatusFBM" NOT NULL DEFAULT 'DRAFT',
    "sendcloudParcelId" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "labelUrl" TEXT,
    "serviceCode" TEXT,
    "serviceName" TEXT,
    "weightGrams" INTEGER,
    "lengthCm" DECIMAL(10,2),
    "widthCm" DECIMAL(10,2),
    "heightCm" DECIMAL(10,2),
    "costCents" INTEGER,
    "currencyCode" TEXT DEFAULT 'EUR',
    "pickedAt" TIMESTAMP(3),
    "packedAt" TIMESTAMP(3),
    "labelPrintedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "trackingPushedAt" TIMESTAMP(3),
    "trackingPushError" TEXT,
    "pickedBy" TEXT,
    "packedBy" TEXT,
    "heldAt" TIMESTAMP(3),
    "heldReason" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "source" TEXT NOT NULL,
    "carrierRawCode" TEXT,
    "carrierRawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingMessageLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "channel" "OrderChannel" NOT NULL,
    "marketplace" TEXT,
    "status" "TrackingMessageStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingMessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '{}',
    "lastFiredAt" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT DEFAULT 'IT',
    "taxId" TEXT,
    "paymentTerms" TEXT,
    "defaultCurrency" TEXT DEFAULT 'EUR',
    "leadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "productionTimeDays" INTEGER,
    "productionUnitsPerDay" INTEGER,
    "shippingTimeDays" INTEGER,
    "leadTimeStdDevDays" DECIMAL(8,2),
    "leadTimeSampleCount" INTEGER NOT NULL DEFAULT 0,
    "leadTimeStatsUpdatedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "autoTriggerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoTriggerMaxQtyPerPo" INTEGER,
    "autoTriggerMaxCostCentsPerPo" INTEGER,
    "autoTriggerEventPrep" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierShippingProfile" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "costPerCbmCents" INTEGER,
    "costPerKgCents" INTEGER,
    "fixedCostCents" INTEGER,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "containerCapacityCbm" DECIMAL(8,2),
    "containerMaxWeightKg" DECIMAL(10,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierShippingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierSku" TEXT,
    "costCents" INTEGER,
    "currencyCode" TEXT DEFAULT 'EUR',
    "moq" INTEGER NOT NULL DEFAULT 1,
    "casePack" INTEGER,
    "leadTimeDaysOverride" INTEGER,
    "productionTimeDaysOverride" INTEGER,
    "productionUnitsPerDayOverride" INTEGER,
    "shippingTimeDaysOverride" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "factoryName" TEXT,
    "factorySize" TEXT,
    "factorySpec" TEXT,
    "lastLandedCostCents" INTEGER,
    "lastLandedCostUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "developmentProjectId" TEXT,
    "poKind" TEXT NOT NULL DEFAULT 'STANDARD',
    "supplierId" TEXT,
    "warehouseId" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedDeliveryDate" TIMESTAMP(3),
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "notes" TEXT,
    "createdBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "supplierConfirmedDeliveryDate" TIMESTAMP(3),
    "supplierConfirmedAt" TIMESTAMP(3),
    "supplierAckToken" TEXT,
    "supplierAckExpiresAt" TIMESTAMP(3),
    "approverAckToken" TEXT,
    "approverAckExpiresAt" TIMESTAMP(3),
    "shipToAddress" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "productId" TEXT,
    "supplierSku" TEXT,
    "sku" TEXT NOT NULL,
    "quantityOrdered" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "lineOrder" INTEGER NOT NULL DEFAULT 0,
    "factoryName" TEXT,
    "factorySize" TEXT,
    "factorySpec" TEXT,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderAttachment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT,
    "contentType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderRevision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapshotJson" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierNotifiedAt" TIMESTAMP(3),
    "supplierAckedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PurchaseOrderRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoComment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "userId" TEXT,
    "body" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "PoComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoEventLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "poId" TEXT,
    "poNumber" TEXT,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "supplierId" TEXT,
    "warehouseId" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PoTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoTemplateItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "productId" TEXT,
    "supplierSku" TEXT,
    "sku" TEXT NOT NULL,
    "quantityOrdered" INTEGER NOT NULL,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "lineOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PoTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoSchedule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "cadenceInterval" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastGeneratedPoId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expectedLeadDays" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PoSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundShipment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "type" "InboundType" NOT NULL,
    "status" "InboundStatus" NOT NULL DEFAULT 'DRAFT',
    "reference" TEXT,
    "warehouseId" TEXT,
    "fbaShipmentId" TEXT,
    "purchaseOrderId" TEXT,
    "workOrderId" TEXT,
    "asnNumber" TEXT,
    "expectedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "asnFileUrl" TEXT,
    "carrierCode" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "exchangeRate" DECIMAL(12,6),
    "shippingCostCents" INTEGER,
    "customsCostCents" INTEGER,
    "dutiesCostCents" INTEGER,
    "insuranceCostCents" INTEGER,
    "createdById" TEXT,
    "receivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "InboundShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundShipmentAttachment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "inboundShipmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT,
    "contentType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundShipmentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundDiscrepancy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "inboundShipmentId" TEXT NOT NULL,
    "inboundShipmentItemId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "expectedValue" TEXT,
    "actualValue" TEXT,
    "quantityImpact" INTEGER,
    "costImpactCents" INTEGER,
    "description" TEXT,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,

    CONSTRAINT "InboundDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundShipmentItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "inboundShipmentId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "quantityExpected" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "qcStatus" TEXT,
    "qcNotes" TEXT,
    "purchaseOrderItemId" TEXT,
    "unitCostCents" INTEGER,
    "costVarianceCents" INTEGER,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lotNumber" TEXT,
    "expiryDate" TIMESTAMP(3),

    CONSTRAINT "InboundShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundReceipt" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "inboundShipmentItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "qcStatus" TEXT,
    "qcNotes" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "stockMovementId" TEXT,
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'PLANNED',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "costCents" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Return" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "channelReturnId" TEXT,
    "rmaNumber" TEXT,
    "status" "ReturnStatusFlow" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "conditionGrade" "ReturnConditionGrade",
    "refundStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "refundCents" INTEGER,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "channelRefundId" TEXT,
    "channelRefundError" TEXT,
    "channelRefundedAt" TIMESTAMP(3),
    "isFbaReturn" BOOLEAN NOT NULL DEFAULT false,
    "restockChannel" TEXT,
    "restockWarehouseId" TEXT,
    "returnType" TEXT NOT NULL DEFAULT 'STANDARD',
    "warrantyStatus" TEXT,
    "warrantyResolution" TEXT,
    "defectReportedAt" TIMESTAMP(3),
    "manufacturerRef" TEXT,
    "receivedAt" TIMESTAMP(3),
    "inspectedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "restockedAt" TIMESTAMP(3),
    "returnLabelUrl" TEXT,
    "returnLabelCarrier" TEXT,
    "returnTrackingNumber" TEXT,
    "returnLabelGeneratedAt" TIMESTAMP(3),
    "returnLabelEmailedAt" TIMESTAMP(3),
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sendcloudParcelId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "conditionGrade" "ReturnConditionGrade",
    "notes" TEXT,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inspectionChecklist" JSONB,
    "disposition" TEXT,
    "scrapReason" TEXT,
    "lotId" TEXT,

    CONSTRAINT "ReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "perLineAmounts" JSONB,
    "kind" "RefundKind" NOT NULL DEFAULT 'CASH',
    "reason" TEXT,
    "channel" TEXT NOT NULL,
    "channelRefundId" TEXT,
    "channelStatus" "RefundChannelStatus" NOT NULL DEFAULT 'PENDING',
    "channelError" TEXT,
    "channelPostedAt" TIMESTAMP(3),
    "actor" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundAttempt" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "channelRefundId" TEXT,
    "errorMessage" TEXT,
    "rawRequest" JSONB,
    "rawResponse" JSONB,
    "durationMs" INTEGER,

    CONSTRAINT "RefundAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnPolicy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "productType" TEXT,
    "windowDays" INTEGER NOT NULL DEFAULT 14,
    "refundDeadlineDays" INTEGER NOT NULL DEFAULT 14,
    "buyerPaysReturn" BOOLEAN NOT NULL DEFAULT false,
    "restockingFeePct" DECIMAL(5,2),
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "highValueThresholdCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minStock" INTEGER,
    "reorderPoint" INTEGER,
    "reorderQuantity" INTEGER,
    "safetyStockDays" INTEGER NOT NULL DEFAULT 7,
    "preferredSupplierId" TEXT,
    "isManufactured" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "autoTriggerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplenishmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentRecommendation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "velocity" DECIMAL(10,2) NOT NULL,
    "velocitySource" TEXT NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "leadTimeSource" TEXT NOT NULL,
    "safetyDays" INTEGER NOT NULL,
    "totalAvailable" INTEGER NOT NULL,
    "inboundWithinLeadTime" INTEGER NOT NULL,
    "effectiveStock" INTEGER NOT NULL,
    "reorderPoint" INTEGER NOT NULL,
    "reorderQuantity" INTEGER NOT NULL,
    "daysOfStockLeft" INTEGER,
    "urgency" TEXT NOT NULL,
    "needsReorder" BOOLEAN NOT NULL,
    "safetyStockUnits" INTEGER,
    "eoqUnits" INTEGER,
    "constraintsApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unitCostCents" INTEGER,
    "urgencySource" TEXT,
    "worstChannelKey" TEXT,
    "worstChannelDaysOfCover" INTEGER,
    "leadTimeStdDevDays" DECIMAL(8,2),
    "prepEventId" TEXT,
    "prepExtraUnits" INTEGER,
    "unitCostCurrency" TEXT,
    "fxRateUsed" DECIMAL(14,6),
    "rawVelocity" DECIMAL(10,2),
    "substitutionAdjustedDelta" DECIMAL(10,2),
    "freightCostPerUnitCents" INTEGER,
    "landedCostPerUnitCents" INTEGER,
    "amazonRecommendedQty" INTEGER,
    "amazonDeltaPct" DECIMAL(8,2),
    "amazonReportAsOf" TIMESTAMP(3),
    "preferredSupplierId" TEXT,
    "isManufactured" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "actedAt" TIMESTAMP(3),
    "actedByUserId" TEXT,
    "resultingPoId" TEXT,
    "resultingWorkOrderId" TEXT,
    "overrideQuantity" INTEGER,
    "overrideNotes" TEXT,
    "overrideByUserId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByUserId" TEXT,
    "dismissedReason" TEXT,

    CONSTRAINT "ReplenishmentRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleCount" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "startedAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CycleCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleCountItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "cycleCountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variationId" TEXT,
    "sku" TEXT NOT NULL,
    "expectedQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "countedAt" TIMESTAMP(3),
    "countedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reconciledMovementId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciledByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CycleCountItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRoutingRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "channel" TEXT,
    "marketplace" TEXT,
    "shippingCountry" TEXT,
    "warehouseId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "OrderRoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentSavedView" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filterState" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "ReplenishmentSavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "errorMessage" TEXT,
    "outputSummary" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'cron',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundApiCallLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "connectionId" TEXT,
    "operation" TEXT NOT NULL,
    "endpoint" TEXT,
    "method" TEXT,
    "statusCode" INTEGER,
    "success" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "errorType" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'api',
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "productId" TEXT,
    "listingId" TEXT,
    "orderId" TEXT,
    "outcome" TEXT,
    "errorClass" TEXT,
    "rateLimitRemaining" DOUBLE PRECISION,
    "rateLimitLimit" DOUBLE PRECISION,
    "idempotencyKey" TEXT,
    "attempts" INTEGER,
    "apiVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundApiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLogErrorGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "errorType" TEXT,
    "errorCode" TEXT,
    "sampleMessage" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncLogErrorGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLogSavedSearch" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncLogSavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "windowMinutes" INTEGER NOT NULL DEFAULT 15,
    "channel" TEXT,
    "notificationChannels" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastValue" DOUBLE PRECISION,
    "lastFired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRIGGERED',
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "notes" TEXT,
    "notifications" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSubstitution" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "primaryProductId" TEXT NOT NULL,
    "substituteProductId" TEXT NOT NULL,
    "substitutionFraction" DECIMAL(3,2) NOT NULL DEFAULT 0.50,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSubstitution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockoutEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "locationId" TEXT,
    "channel" TEXT,
    "marketplace" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "detectedBy" TEXT NOT NULL,
    "closedBy" TEXT,
    "velocityAtStart" DECIMAL(10,2) NOT NULL,
    "marginCentsPerUnit" INTEGER,
    "unitCostCents" INTEGER,
    "sellingPriceCents" INTEGER,
    "durationDays" DECIMAL(8,2),
    "estimatedLostUnits" INTEGER,
    "estimatedLostRevenue" INTEGER,
    "estimatedLostMargin" INTEGER,
    "notes" TEXT,

    CONSTRAINT "StockoutEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoPoRunLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "triggeredBy" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "posCreated" INTEGER NOT NULL DEFAULT 0,
    "totalUnitsCreated" INTEGER NOT NULL DEFAULT 0,
    "totalCostCentsCreated" INTEGER NOT NULL DEFAULT 0,
    "declinedNoOptIn" INTEGER NOT NULL DEFAULT 0,
    "declinedQtyCeiling" INTEGER NOT NULL DEFAULT 0,
    "declinedCostCeiling" INTEGER NOT NULL DEFAULT 0,
    "declinedPerProductOptOut" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdPoIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "AutoPoRunLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaRestockReport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "marketplaceCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reportId" TEXT,
    "reportDocumentId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "payloadDigest" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "durationMs" INTEGER,

    CONSTRAINT "FbaRestockReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaRestockRow" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "recommendedReplenishmentQty" INTEGER,
    "daysOfSupply" DECIMAL(8,2),
    "recommendedShipDate" TIMESTAMP(3),
    "daysToInbound" INTEGER,
    "salesPace30dUnits" INTEGER,
    "salesShortageUnits" INTEGER,
    "alertType" TEXT,
    "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FbaRestockRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaInboundPlanV2" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "inboundShipmentId" TEXT,
    "planId" TEXT,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentStep" TEXT NOT NULL DEFAULT 'CREATE',
    "operationIds" JSONB,
    "selectedPackingOptionId" TEXT,
    "selectedPlacementOptionId" TEXT,
    "selectedTransportationOptions" JSONB,
    "shipmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "labels" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),

    CONSTRAINT "FbaInboundPlanV2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "icon" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetTag" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "assetId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetTag_pkey" PRIMARY KEY ("assetId","tagId")
);

-- CreateTable
CREATE TABLE "ProductTag" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "productId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductTag_pkey" PRIMARY KEY ("productId","tagId")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "computedCostCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleComponent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCostCents" INTEGER,

    CONSTRAINT "BundleComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'products',
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "defaultProductTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "externalReviewId" TEXT NOT NULL,
    "productId" TEXT,
    "asin" TEXT,
    "sku" TEXT,
    "rating" INTEGER,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "authorName" TEXT,
    "authorId" TEXT,
    "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
    "helpfulVotes" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB,
    "ingestSource" TEXT,
    "triageStatus" TEXT,
    "assignee" TEXT,
    "triageTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triageNote" TEXT,
    "triageUpdatedAt" TIMESTAMP(3),
    "attributedRequestId" TEXT,
    "attributedRuleId" TEXT,
    "attributedAt" TIMESTAMP(3),

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewResponse" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "locale" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isAiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "createdBy" TEXT,
    "providerResponseCode" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSpotlight" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "marketplace" TEXT,
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "headline" TEXT,
    "content" JSONB NOT NULL,
    "model" TEXT,
    "usedAi" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSpotlight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewActionItem" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "spikeId" TEXT,
    "productId" TEXT,
    "marketplace" TEXT,
    "category" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSentiment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "score" DECIMAL(4,3) NOT NULL,
    "categories" TEXT[],
    "topPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSentiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewCategoryRate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "positive" INTEGER NOT NULL DEFAULT 0,
    "neutral" INTEGER NOT NULL DEFAULT 0,
    "negative" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCategoryRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSpike" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "marketplace" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rate7dNumerator" INTEGER NOT NULL,
    "rate7dDenominator" INTEGER NOT NULL,
    "rate28dNumerator" INTEGER NOT NULL,
    "rate28dDenominator" INTEGER NOT NULL,
    "spikeMultiplier" DECIMAL(6,2),
    "sampleTopPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSpike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonReviewInsight" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productId" TEXT,
    "starRating" DOUBLE PRECISION,
    "reviewCount" INTEGER,
    "positiveTopics" JSONB NOT NULL DEFAULT '[]',
    "negativeTopics" JSONB NOT NULL DEFAULT '[]',
    "snippets" JSONB NOT NULL DEFAULT '[]',
    "trend" JSONB NOT NULL DEFAULT '[]',
    "accessStatus" TEXT NOT NULL DEFAULT 'OK',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,

    CONSTRAINT "AmazonReviewInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "status" "ReviewRequestStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "scheduledFor" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerRequestId" TEXT,
    "providerResponseCode" TEXT,
    "errorMessage" TEXT,
    "suppressedReason" TEXT,
    "ruleId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "ReviewRuleScope" NOT NULL,
    "marketplace" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "minDaysSinceDelivery" INTEGER NOT NULL DEFAULT 7,
    "maxDaysSinceDelivery" INTEGER NOT NULL DEFAULT 25,
    "exclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minOrderTotalCents" INTEGER,
    "createdBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "useSentimentDiversion" BOOLEAN NOT NULL DEFAULT false,
    "fallbackOnNoResponse" BOOLEAN NOT NULL DEFAULT true,
    "productTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sendDelayDays" INTEGER,
    "anchor" TEXT NOT NULL DEFAULT 'DELIVERY',
    "sendHourLocal" INTEGER,
    "skipWeekends" BOOLEAN NOT NULL DEFAULT false,
    "shiftToBestDay" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ReviewRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewTimingDefault" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "delayDays" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewTimingDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSendWindow" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT '*',
    "dayOfWeek" INTEGER NOT NULL,
    "hourLocal" INTEGER NOT NULL,
    "dayRank" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSendWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSentimentCheck" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ruleId" TEXT,
    "reviewRequestId" TEXT,
    "sentimentEmailSentAt" TIMESTAMP(3),
    "response" TEXT NOT NULL DEFAULT 'NONE',
    "respondedAt" TIMESTAMP(3),
    "respondedFromIp" TEXT,
    "respondedFromUserAgent" TEXT,
    "feedback" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSentimentCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewMailerState" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL DEFAULT 'default',
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pausedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewMailerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "channel" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTag" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "orderId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderTag_pkey" PRIMARY KEY ("orderId","tagId")
);

-- CreateTable
CREATE TABLE "AiUsageLog" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "feature" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiFeatureModelPref" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFeatureModelPref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAiDraft" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cellKey" TEXT NOT NULL,
    "channel" TEXT,
    "marketplace" TEXT,
    "aliasLabel" TEXT,
    "locale" TEXT,
    "market" TEXT,
    "writeField" TEXT NOT NULL,
    "columnKey" TEXT NOT NULL,
    "draftValue" JSONB NOT NULL,
    "baseValue" JSONB,
    "baseSource" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confidence" TEXT,
    "rationale" TEXT,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "capsUsed" JSONB,
    "violations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "appliedAuditId" TEXT,
    "lastApplyError" TEXT,

    CONSTRAINT "ProductAiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "surface" TEXT,
    "autonomyTier" TEXT NOT NULL DEFAULT 'suggest',
    "modelFeature" TEXT,
    "systemPrompt" TEXT,
    "toolNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerType" TEXT NOT NULL DEFAULT 'on_demand',
    "triggerConfig" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "agentId" TEXT,
    "agentKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "entityType" TEXT,
    "entityId" TEXT,
    "input" JSONB,
    "output" JSONB,
    "steps" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "model" TEXT,
    "provider" TEXT,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "userId" TEXT,
    "charterVersion" INTEGER,
    "charterRevisionId" TEXT,
    "mode" TEXT,
    "parentRunId" TEXT,
    "orchestrationId" TEXT,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "haltedReason" TEXT,
    "workflowKey" TEXT,
    "workflowRevisionId" TEXT,
    "assignmentId" TEXT,
    "via" TEXT,
    "oauthGrantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTool" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "riskTier" TEXT NOT NULL DEFAULT 'low',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitPerHour" INTEGER,
    "dailyBudgetUSD" DECIMAL(12,6),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApproval" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "riskTier" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "preview" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "operatorNote" TEXT,
    "expiresAt" TIMESTAMP(3),
    "executeAfter" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "description" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "language" TEXT,
    "marketplace" TEXT,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "editedCount" INTEGER NOT NULL DEFAULT 0,
    "totalEditChars" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT 'default-user',
    "type" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "targetValue" DECIMAL(14,2) NOT NULL,
    "currency" TEXT,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardLayout" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT 'default-user',
    "hiddenWidgets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "widgetOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activeViewId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardView" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT 'default-user',
    "name" TEXT NOT NULL,
    "hiddenWidgets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "widgetOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledReport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT 'default-user',
    "email" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "hourLocal" INTEGER NOT NULL DEFAULT 8,
    "viewId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "meta" JSONB,
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedViewAlert" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "savedViewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "comparison" TEXT NOT NULL,
    "threshold" DECIMAL(14,4) NOT NULL,
    "baselineCount" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCount" INTEGER NOT NULL DEFAULT 0,
    "lastFiredAt" TIMESTAMP(3),
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedViewAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTranslation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "bulletPoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "sourceHash" TEXT,
    "authoredAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "sourceModel" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRelation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "fromProductId" TEXT NOT NULL,
    "toProductId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSeo" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "urlHandle" TEXT,
    "ogTitle" TEXT,
    "ogDescription" TEXT,
    "ogImageUrl" TEXT,
    "canonicalUrl" TEXT,
    "schemaOrgJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSeo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCertificate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "certType" TEXT NOT NULL,
    "certNumber" TEXT,
    "standard" TEXT,
    "issuingBody" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "fileUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelPublishAttempt" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productId" TEXT,
    "mode" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "submissionId" TEXT,
    "payloadDigest" TEXT NOT NULL,
    "durationMs" INTEGER,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelPublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayCampaign" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "externalCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fundingStrategy" TEXT NOT NULL,
    "fundingModel" TEXT,
    "bidPercentage" DECIMAL(6,2),
    "dailyBudget" DECIMAL(10,2),
    "budgetCurrency" TEXT,
    "campaignTargetingType" TEXT,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "adRateStrategy" TEXT,
    "dynamicAdRatePrefs" JSONB,
    "campaignCriterion" JSONB,
    "isRulesBased" BOOLEAN NOT NULL DEFAULT false,
    "nexusManaged" BOOLEAN NOT NULL DEFAULT false,
    "budgetUpdatesToday" INTEGER NOT NULL DEFAULT 0,
    "budgetUpdatesDay" TIMESTAMP(3),
    "lastEntitySyncAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "sales" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "spend" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "metricsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayRateDiscoveryPlan" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "floorPct" DECIMAL(6,2) NOT NULL,
    "capPct" DECIMAL(6,2) NOT NULL,
    "stepPct" DECIMAL(6,2) NOT NULL,
    "dwellDays" INTEGER NOT NULL,
    "currentPct" DECIMAL(6,2),
    "lastStepAt" TIMESTAMP(3),
    "history" JSONB NOT NULL DEFAULT '[]',
    "bestPct" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayRateDiscoveryPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayCampaignAutomationPolicy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "posture" TEXT NOT NULL DEFAULT 'INHERIT',
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "rateCapPct" DECIMAL(6,2),
    "rateFloorPct" DECIMAL(6,2),
    "bidCapCents" INTEGER,
    "bidFloorCents" INTEGER,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayCampaignAutomationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalAdGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "defaultBidCents" INTEGER,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAd" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "marketplace" TEXT NOT NULL,
    "listingId" TEXT,
    "inventoryReference" TEXT,
    "inventoryReferenceType" TEXT,
    "externalAdId" TEXT,
    "bidPercentage" DECIMAL(6,2),
    "status" TEXT NOT NULL,
    "createdVia" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "hiddenReason" TEXT,
    "productId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayKeyword" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "externalKeywordId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "bidCents" INTEGER,
    "status" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayNegativeKeyword" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "externalId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayNegativeKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsReportTask" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "fundingModel" TEXT NOT NULL,
    "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dateFrom" DATE NOT NULL,
    "dateTo" DATE NOT NULL,
    "dimensions" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "externalTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reportHref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "rowsIngested" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsReportTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsDailyPerformance" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "fundingModel" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "ctr" DECIMAL(8,5),
    "avgCostPerClickCents" INTEGER,
    "adFeesCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "soldQty" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "extra" JSONB,
    "reportTaskId" TEXT,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsDailyPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayListingIndex" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "imageUrl" TEXT,
    "title" TEXT,
    "categoryId" TEXT,
    "price" DECIMAL(10,2),
    "currency" TEXT,
    "quantity" INTEGER,
    "quantitySold" INTEGER,
    "format" TEXT,
    "variationSkus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aspects" JSONB,
    "source" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "relistedFromItemId" TEXT,
    "detailSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayListingIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayListingEconomics" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "productId" TEXT,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "cogsCents" INTEGER,
    "ebayFeesCents" INTEGER,
    "feesSource" TEXT,
    "shippingCostCents" INTEGER,
    "contributionMarginCents" INTEGER,
    "contributionMarginPct" DECIMAL(6,2),
    "breakEvenAdRatePct" DECIMAL(6,2),
    "breakEvenCpcCents" INTEGER,
    "dataStatus" TEXT NOT NULL DEFAULT 'MISSING_COGS',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayListingEconomics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAutomationState" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "globalMode" TEXT NOT NULL DEFAULT 'OFF',
    "halted" BOOLEAN NOT NULL DEFAULT false,
    "haltReason" TEXT,
    "haltedBy" TEXT,
    "maxHourlySpendCentsEur" INTEGER,
    "maxActionsPerHour" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAutomationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingSpendCeiling" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "monthlyCapCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingSpendCeiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'PROPOSE',
    "marketplace" TEXT,
    "scope" JSONB,
    "trigger" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "guardrails" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "cooldownHours" INTEGER NOT NULL DEFAULT 24,
    "lastEvaluatedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsRuleVersion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" TEXT,
    "scope" JSONB,
    "trigger" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "guardrails" JSONB,
    "cooldownHours" INTEGER NOT NULL,
    "changedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayAdsRuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsRuleExecution" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evaluated" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "proposed" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "ruleVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayAdsRuleExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsProposal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT,
    "kind" TEXT NOT NULL,
    "entityRef" JSONB NOT NULL,
    "proposedAction" JSONB NOT NULL,
    "reasoning" JSONB,
    "proposedKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "estimatedImpact" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedResult" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsDigest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "EbayAdsDigest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayWatcherStats" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "watcherCount" INTEGER NOT NULL DEFAULT 0,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayWatcherStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayMarkdown" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "externalPromotionId" TEXT,
    "discountType" TEXT NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "originalPrice" DECIMAL(10,2) NOT NULL,
    "markdownPrice" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayMarkdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayVolumePromotion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "tiers" JSONB NOT NULL,
    "skus" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "externalPromotionId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayVolumePromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayVolumeTierTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tiers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayVolumeTierTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledProductChange" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledProductChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "domain" TEXT NOT NULL DEFAULT 'replenishment',
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "autonomyLevel" TEXT NOT NULL DEFAULT 'PROPOSE',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "maxExecutionsPerDay" INTEGER DEFAULT 100,
    "maxWritesPerDay" INTEGER,
    "maxValueCentsEur" INTEGER,
    "maxDailyAdSpendCentsEur" INTEGER,
    "scopeMarketplace" TEXT,
    "scopePortfolioId" TEXT,
    "scopeCampaignId" TEXT,
    "scopeProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "evaluationCount" INTEGER NOT NULL DEFAULT 0,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastMatchedAt" TIMESTAMP(3),
    "lastExecutedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRuleAssignment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'budget',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "CampaignRuleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRuleTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT 'advertising',
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AutomationRuleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRuleExecution" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "triggerData" JSONB NOT NULL,
    "actionResults" JSONB NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "AutomationRuleExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsRuleSuggestion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT,
    "executionId" TEXT,
    "trigger" TEXT,
    "marketplace" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "proposedAction" JSONB NOT NULL,
    "proposedKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "appliedResult" JSONB,

    CONSTRAINT "AdsRuleSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsSuggestionMute" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'rules',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "marketplace" TEXT,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsSuggestionMute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordRank" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "asin" TEXT,
    "organicRank" INTEGER,
    "sponsoredRank" INTEGER,
    "searchVolume" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeywordRank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scenario" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "horizonDays" INTEGER NOT NULL DEFAULT 90,
    "isSaved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "recsAffected" INTEGER NOT NULL DEFAULT 0,
    "totalUnitsDelta" INTEGER NOT NULL DEFAULT 0,
    "totalCostDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "ScenarioRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingReconciliation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "externalSku" TEXT NOT NULL,
    "externalListingId" TEXT,
    "parentAsin" TEXT,
    "title" TEXT,
    "channelPrice" DECIMAL(10,2),
    "channelQuantity" INTEGER,
    "channelStatus" TEXT,
    "matchedProductId" TEXT,
    "matchedVariationId" TEXT,
    "matchMethod" TEXT,
    "matchConfidence" DOUBLE PRECISION,
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "conflictNotes" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "runId" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlatFilePullRecord" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "jobId" TEXT,
    "skusRequested" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skusReturned" INTEGER NOT NULL DEFAULT 0,
    "columnsApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rowsApplied" INTEGER NOT NULL DEFAULT 0,
    "fieldsApplied" INTEGER NOT NULL DEFAULT 0,
    "appliedAt" TIMESTAMP(3),
    "operatorNote" TEXT,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlatFilePullRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlatFilePullJob" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productType" TEXT,
    "skus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'running',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "pulled" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "rows" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "fatalError" TEXT,

    CONSTRAINT "FlatFilePullJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogOrganizeSession" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoExpiresAt" TIMESTAMP(3) NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogOrganizeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogOrganizeChange" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "toParentId" TEXT NOT NULL,
    "fromParentId" TEXT,
    "fromVariantAttributes" JSONB,
    "attributes" JSONB,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "queueIds" TEXT[],
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogOrganizeChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductReadCache" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "asin" TEXT,
    "brand" TEXT,
    "basePrice" DECIMAL(10,2),
    "totalStock" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER,
    "status" TEXT NOT NULL,
    "syncChannels" TEXT[],
    "productType" TEXT,
    "fulfillmentMethod" TEXT,
    "isParent" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "familyId" TEXT,
    "familyJson" JSONB,
    "workflowStageId" TEXT,
    "workflowStageJson" JSONB,
    "imageUrl" TEXT,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "channelCount" INTEGER NOT NULL DEFAULT 0,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "childCount" INTEGER NOT NULL DEFAULT 0,
    "hasDescription" BOOLEAN NOT NULL DEFAULT false,
    "hasBrand" BOOLEAN NOT NULL DEFAULT false,
    "hasGtin" BOOLEAN NOT NULL DEFAULT false,
    "hasPhotos" BOOLEAN NOT NULL DEFAULT false,
    "channelKeys" TEXT[],
    "rollupChannelKeys" TEXT[],
    "coverageJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "primaryCategoryId" TEXT,
    "categoryIds" TEXT[],
    "categoryPathJson" JSONB,
    "cacheRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driftCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductReadCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "slug" TEXT NOT NULL,
    "code" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "name" JSONB NOT NULL DEFAULT '{"en":{},"it":{}}',
    "description" JSONB,
    "attributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryClosure" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "ancestorId" TEXT NOT NULL,
    "descendantId" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "CategoryClosure_pkey" PRIMARY KEY ("ancestorId","descendantId")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "productId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("productId","categoryId")
);

-- CreateTable
CREATE TABLE "FnskuLabelTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FnskuLabelTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "data" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingQualitySnapshot" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "overallScore" INTEGER NOT NULL,
    "dimensions" JSONB NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingQualitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingDecision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "method" TEXT NOT NULL,
    "ruleId" TEXT,
    "scoreSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedTransformRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "field" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "condition" JSONB,
    "action" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedTransformRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelSchema" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT,
    "fieldKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maxLength" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "allowedValues" JSONB,
    "notes" TEXT,

    CONSTRAINT "ChannelSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaReimbursement" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reimbursementId" TEXT NOT NULL,
    "approvalDate" TIMESTAMP(3) NOT NULL,
    "caseId" TEXT,
    "amazonOrderId" TEXT,
    "reason" TEXT,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT,
    "asin" TEXT,
    "quantityReimbursed" INTEGER NOT NULL DEFAULT 0,
    "amountPerUnitCents" INTEGER NOT NULL DEFAULT 0,
    "totalAmountCents" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "marketplaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FbaReimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaInventoryAdjustment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "adjustedDate" TIMESTAMP(3) NOT NULL,
    "transactionType" TEXT NOT NULL,
    "fnsku" TEXT,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "quantity" INTEGER NOT NULL,
    "fulfillmentCenterId" TEXT,
    "reasonCode" TEXT,
    "disposition" TEXT,
    "marketplaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FbaInventoryAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" "MktChannel" NOT NULL,
    "surface" "MktSurface" NOT NULL,
    "objective" "MktObjective" NOT NULL DEFAULT 'SALES',
    "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryMarketplace" TEXT,
    "budgetScope" TEXT NOT NULL DEFAULT 'SINGLE_MARKET',
    "name" TEXT NOT NULL,
    "status" "MktStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "connectionId" TEXT,
    "budgetCents" INTEGER,
    "budgetKind" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "acos" DECIMAL(8,4),
    "roas" DECIMAL(8,4),
    "deliveryStatus" TEXT,
    "deliveryReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaignLink" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT,
    "externalParentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "deliveryStatus" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaignLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsCampaignDetail" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "profileId" TEXT,
    "portfolioId" TEXT,
    "bidStrategyJson" JSONB,
    "dynamicBidding" JSONB,
    "tactic" TEXT,
    "costType" TEXT,
    "deliveryProfileNative" TEXT,
    "creativeAssetJson" JSONB,
    "brandEntityId" TEXT,

    CONSTRAINT "AmazonAdsCampaignDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayPromotedDetail" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "fundingStrategy" TEXT NOT NULL DEFAULT 'STANDARD',
    "bidPercentage" DECIMAL(5,2),
    "channelConnectionId" TEXT,

    CONSTRAINT "EbayPromotedDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountDetail" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "discountType" TEXT NOT NULL,
    "discountValueCents" INTEGER,
    "discountPercent" DECIMAL(5,2),
    "appliesTo" TEXT NOT NULL DEFAULT 'ALL',
    "appliesToRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "combinesWith" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "usageLimit" INTEGER,
    "priceRuleId" TEXT,
    "discountCodeId" TEXT,

    CONSTRAINT "DiscountDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalAdsDetail" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT,
    "objectiveNative" TEXT,
    "optimizationGoal" TEXT,
    "creativeRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platformConfigJson" JSONB,

    CONSTRAINT "ExternalAdsDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPushDetail" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "aPlusContentId" TEXT,
    "brandStoryId" TEXT,
    "targetRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ContentPushDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDetail" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "segmentId" TEXT,
    "templateId" TEXT,

    CONSTRAINT "OutreachDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdMutation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalEntityId" TEXT,
    "profileId" TEXT,
    "marketplace" TEXT,
    "field" TEXT NOT NULL,
    "intendedValue" TEXT,
    "previousValue" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "changeSetId" TEXT,
    "importJobId" TEXT,
    "ruleId" TEXT,
    "actor" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "holdUntil" TIMESTAMP(3),
    "outboundQueueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "AdMutation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdBlueprintApplication" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "blueprintId" TEXT,
    "productToken" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "asins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "plan" JSONB NOT NULL,
    "acceptedConflicts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skippedTargets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdCampaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notOnAmazon" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "sourceSelector" JSONB,
    "options" JSONB,
    "edits" JSONB,
    "launchMode" TEXT,
    "progress" JSONB,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "AdBlueprintApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdKeywordProtection" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "isPrefix" BOOLEAN NOT NULL DEFAULT false,
    "matchType" TEXT,
    "marketplace" TEXT,
    "campaignId" TEXT,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdKeywordProtection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdNegativeReview" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "protectedTerm" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdNegativeReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdBlueprint" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    "productToken" TEXT NOT NULL,
    "competitorTokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceCampaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "doc" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdBlueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTarget" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expressionType" TEXT,
    "expressionValue" TEXT NOT NULL,
    "isNegative" BOOLEAN NOT NULL DEFAULT false,
    "negativeLevel" TEXT,
    "segmentId" TEXT,
    "bidCents" INTEGER,
    "marketplace" TEXT,
    "externalTargetId" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ENABLED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBudget" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'POOL',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "totalDailyCents" INTEGER NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'STATIC',
    "coolDownMinutes" INTEGER NOT NULL DEFAULT 60,
    "maxShiftPerRebalancePct" INTEGER NOT NULL DEFAULT 20,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "lastRebalancedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CampaignBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBudgetAllocation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channel" "MktChannel" NOT NULL,
    "marketplace" TEXT,
    "targetSharePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "minDailyBudgetCents" INTEGER NOT NULL DEFAULT 100,
    "maxDailyBudgetCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignBudgetAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBudgetRebalance" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "outputs" JSONB NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "totalShiftCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignBudgetRebalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignMetric" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "linkId" TEXT,
    "channel" "MktChannel" NOT NULL,
    "marketplace" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "localEntityId" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "costEurCents" BIGINT,
    "sales7dCents" INTEGER DEFAULT 0,
    "sales14dCents" INTEGER DEFAULT 0,
    "sales30dCents" INTEGER DEFAULT 0,
    "orders7d" INTEGER DEFAULT 0,
    "units7d" INTEGER DEFAULT 0,
    "ntbOrders14d" INTEGER,
    "viewableImpressions" INTEGER,
    "detailPageViews7d" INTEGER,
    "extra" JSONB,
    "attributionModel" TEXT,
    "acos7d" DECIMAL(8,4),
    "roas7d" DECIMAL(8,4),
    "reportRunId" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAction" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "executionId" TEXT,
    "userId" TEXT,
    "channel" "MktChannel" NOT NULL,
    "actionType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadBefore" JSONB NOT NULL,
    "payloadAfter" JSONB NOT NULL,
    "outboundQueueId" TEXT,
    "channelResponseId" TEXT,
    "channelResponseStatus" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEntry" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "retailEventId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "channel" "MktChannel",
    "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "color" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSchedule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultTargetKey" TEXT,
    "lastApplied" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "originalBids" JSONB,
    "targetOverrides" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "groupId" TEXT,

    CONSTRAINT "AdSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankScheduleGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "targetOverrides" JSONB NOT NULL DEFAULT '{}',
    "portfolioId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "RankScheduleGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankScheduleEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankScheduleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankScheduleVersion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "campaignCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankScheduleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetSchedule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BUDGET',
    "type" TEXT NOT NULL DEFAULT 'CAMPAIGN_BUDGET',
    "campaigns" JSONB NOT NULL DEFAULT '[]',
    "windows" JSONB NOT NULL DEFAULT '[]',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "chartPrefs" JSONB NOT NULL DEFAULT '{}',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "neverExpire" BOOLEAN NOT NULL DEFAULT true,
    "excludeDates" JSONB NOT NULL DEFAULT '[]',
    "autoRefill" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastApplied" JSONB,
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "BudgetSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutopilotPlan" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productGroupName" TEXT,
    "campaignIds" JSONB NOT NULL DEFAULT '[]',
    "goal" TEXT NOT NULL DEFAULT 'BALANCED',
    "autonomy" TEXT NOT NULL DEFAULT 'SUGGEST',
    "guardrails" JSONB NOT NULL DEFAULT '{}',
    "modules" JSONB NOT NULL DEFAULT '{}',
    "graph" JSONB NOT NULL DEFAULT '{}',
    "linkedRuleIds" JSONB NOT NULL DEFAULT '[]',
    "stage" TEXT NOT NULL DEFAULT 'launch',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastDecisionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AutopilotPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutopilotDecision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycle" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "campaignId" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "executionId" TEXT,
    "outboundQueueId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'autopilot',

    CONSTRAINT "AutopilotDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankTarget" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'PLACEMENT_TOP',
    "targetISPct" INTEGER,
    "acosCapPct" INTEGER,
    "maxCpcCents" INTEGER,
    "biasPct" INTEGER,
    "jumpStartPct" INTEGER,
    "stepUpPct" INTEGER,
    "stepDownPct" INTEGER,
    "maxBiasPct" INTEGER,
    "keepClimbing" BOOLEAN NOT NULL DEFAULT false,
    "pause" BOOLEAN NOT NULL DEFAULT false,
    "floorBidCents" INTEGER,
    "allOut" BOOLEAN NOT NULL DEFAULT false,
    "lanes" JSONB,
    "bidMode" TEXT,
    "bidValueCents" INTEGER,
    "bidDeltaPct" INTEGER,
    "color" TEXT,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "scopeProductId" TEXT,
    "scopeCampaignId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankScheduleTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankScheduleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRankPlan" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "parentAsin" TEXT,
    "marketplace" TEXT NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "familyDailyBudgetCents" INTEGER,
    "familyAcosCapPct" INTEGER,
    "maxCampaigns" INTEGER,
    "leadTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "excludeCampaignIds" JSONB NOT NULL DEFAULT '[]',
    "targetOverrides" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "manualOnly" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "ProductRankPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdAudience" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audienceType" TEXT NOT NULL,
    "marketplace" TEXT,
    "lookbackDays" INTEGER NOT NULL DEFAULT 30,
    "asins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "params" JSONB NOT NULL DEFAULT '{}',
    "estimatedReach" INTEGER,
    "reachBasis" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "externalAudienceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AdAudience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdBudgetPlan" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "tag" TEXT,
    "month" TEXT NOT NULL,
    "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "autoPacing" BOOLEAN NOT NULL DEFAULT false,
    "stopOverSpend" BOOLEAN NOT NULL DEFAULT false,
    "calendar" JSONB NOT NULL DEFAULT '[]',
    "campaignLimits" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AdBudgetPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdProductGoal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aiTarget" TEXT NOT NULL,
    "budgetMode" TEXT NOT NULL,
    "advancedAllocation" BOOLEAN NOT NULL DEFAULT false,
    "totalBudgetCents" INTEGER,
    "products" JSONB NOT NULL DEFAULT '[]',
    "seedKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productTargets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeAsins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "marketplace" TEXT,
    "portfolioId" TEXT,
    "campaignIds" JSONB NOT NULL DEFAULT '[]',
    "planId" TEXT,
    "materializedAt" TIMESTAMP(3),
    "targetAcosPct" INTEGER,
    "bidMinCents" INTEGER,
    "bidMaxCents" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdProductGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierContact" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "wechat" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierComm" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "contactId" TEXT,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUT',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "byUserId" TEXT,
    "emailTo" TEXT,
    "emailOk" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierComm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierFollowUp" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "nextAction" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentProject" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONCEPT',
    "productType" TEXT,
    "brief" TEXT,
    "targetCostCents" INTEGER,
    "targetLaunchDate" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "linkedProductId" TEXT,
    "sizeChart" JSONB,
    "materials" JSONB,
    "colorways" JSONB,
    "specNotes" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevelopmentProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentProjectSupplier" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "quotedCostCents" INTEGER,
    "sampleStatus" TEXT,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevelopmentProjectSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentAttachment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TECH_PACK',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "caption" TEXT,
    "includeInPack" BOOLEAN NOT NULL DEFAULT true,
    "url" TEXT NOT NULL,
    "filename" TEXT,
    "sizeBytes" INTEGER,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevelopmentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentCertification" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "certNumber" TEXT,
    "issuer" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "documentUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevelopmentCertification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsAutomationState" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "autonomy" TEXT NOT NULL DEFAULT 'SUGGEST',
    "halted" BOOLEAN NOT NULL DEFAULT false,
    "haltedAt" TIMESTAMP(3),
    "haltReason" TEXT,
    "haltedBy" TEXT,
    "maxHourlySpendCentsEur" INTEGER,
    "maxActionsPerHour" INTEGER,
    "defaultTargetAcosPct" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsAutomationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonReportRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "marketplace" TEXT,
    "source" TEXT NOT NULL DEFAULT 'REPORTS_API',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reportId" TEXT,
    "reportDocumentId" TEXT,
    "dataStartTime" TIMESTAMP(3),
    "dataEndTime" TIMESTAMP(3),
    "rowCount" INTEGER,
    "rawStored" BOOLEAN NOT NULL DEFAULT false,
    "rawRef" TEXT,
    "freshAsOf" TIMESTAMP(3),
    "errorMessage" TEXT,
    "triggeredBy" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedListingMembership" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "parentSku" TEXT NOT NULL,
    "productId" TEXT,
    "variationSpecifics" JSONB NOT NULL,
    "price" DECIMAL(10,2),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "followPool" BOOLEAN NOT NULL DEFAULT true,
    "stockBuffer" INTEGER NOT NULL DEFAULT 0,
    "pinnedQuantity" INTEGER,
    "pinnedUntil" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "lastQtyPushed" INTEGER,
    "lastPushedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "flatFileSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "channelConnectionId" TEXT,

    CONSTRAINT "SharedListingMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncChannelPolicy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "pushesPaused" BOOLEAN NOT NULL DEFAULT false,
    "newListingDefaultMode" TEXT NOT NULL DEFAULT 'FOLLOW',
    "newListingModeSetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channelConnectionId" TEXT,

    CONSTRAINT "SyncChannelPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncControlAudit" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "scopeName" TEXT,
    "field" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncControlAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayDescriptionTheme" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "html" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayDescriptionTheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonTemplateVault" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "templateIdentifier" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headerLanguageTag" TEXT,
    "filename" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonTemplateVault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMappingSet" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "formKind" TEXT NOT NULL,
    "formKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "templateIdentifier" TEXT,
    "templateVersion" TEXT,
    "language" TEXT,
    "layout" JSONB,
    "keyFingerprint" TEXT NOT NULL,
    "basedOnId" TEXT,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelMappingSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMappingField" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "columnKey" TEXT,
    "label" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requirement" TEXT,
    "templateRequirement" TEXT,
    "targetKind" TEXT NOT NULL,
    "targetKey" TEXT,
    "transform" JSONB NOT NULL DEFAULT '[]',
    "direction" TEXT NOT NULL DEFAULT 'both',
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "decidedBy" TEXT NOT NULL DEFAULT 'rule',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChannelMappingField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMappingUse" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reference" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMappingUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonFamilyWorkbook" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "familyKey" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "templateIdentifier" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonFamilyWorkbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportShareLink" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "label" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'default-user',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedReport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "query" JSONB NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'default-user',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedReportVersion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "savedReportId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "query" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'default-user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedReportVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "savedReportId" TEXT NOT NULL,
    "recipients" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xlsx',
    "windowMode" TEXT NOT NULL DEFAULT 'last30',
    "frequency" TEXT NOT NULL,
    "hourLocal" INTEGER NOT NULL DEFAULT 8,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDelivery" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "recipients" TEXT NOT NULL,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "fileName" TEXT,
    "fileBytes" INTEGER,
    "windowFrom" TEXT,
    "windowTo" TEXT,
    "freshness" JSONB,
    "staleNote" TEXT,
    "messageId" TEXT,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsConsoleImport" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'unified-report',
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsMerged" INTEGER NOT NULL DEFAULT 0,
    "rowsNew" INTEGER NOT NULL DEFAULT 0,
    "rowsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "rowsConflicting" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "rowsErrored" INTEGER NOT NULL DEFAULT 0,
    "windowStart" DATE,
    "windowEnd" DATE,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "costCents" BIGINT NOT NULL DEFAULT 0,
    "salesCents" BIGINT NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "notes" TEXT,
    "uploadedBy" TEXT NOT NULL DEFAULT 'default-user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "AdsConsoleImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsConsoleRow" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "windowStart" DATE NOT NULL,
    "windowEnd" DATE NOT NULL,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT,
    "portfolioName" TEXT,
    "adGroupId" TEXT,
    "adGroupName" TEXT,
    "adId" TEXT,
    "asin" TEXT,
    "sku" TEXT,
    "placement" TEXT,
    "targetId" TEXT,
    "targeting" TEXT,
    "matchType" TEXT,
    "searchTerm" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "sourceRows" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsConsoleRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomMetric" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "formula" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'ratio',
    "betterWhen" TEXT,
    "description" TEXT,
    "ownerId" TEXT NOT NULL DEFAULT 'default-user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCharter" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tier" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "outputSchemaKey" TEXT NOT NULL,
    "toolNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "observationKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modelFeature" TEXT NOT NULL,
    "fallbackFeature" TEXT,
    "autonomyLevel" TEXT NOT NULL DEFAULT 'OFF',
    "autonomyCap" TEXT NOT NULL DEFAULT 'PROPOSE',
    "cadence" TEXT,
    "scopeMarketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopePortfolioIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopeCampaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxFindingsPerRun" INTEGER NOT NULL DEFAULT 20,
    "maxToolCallsPerRun" INTEGER NOT NULL DEFAULT 12,
    "maxTokensPerRun" INTEGER NOT NULL DEFAULT 60000,
    "dailyBudgetUSD" DECIMAL(12,6) NOT NULL DEFAULT 1.00,
    "maxProposedValueCents" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "supersededBy" TEXT,
    "modelProviderOverride" TEXT,
    "modelNameOverride" TEXT,
    "pausedUntil" TIMESTAMP(3),
    "pausedReason" TEXT,
    "abEnabled" BOOLEAN NOT NULL DEFAULT false,
    "candidateRevisionId" TEXT,
    "templateKey" TEXT,
    "promptOverlay" TEXT,

    CONSTRAINT "AgentCharter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCharterRevision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "policy" JSONB,
    "note" TEXT NOT NULL,
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "AgentCharterRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvalRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "revisionId" TEXT,
    "baseline" JSONB NOT NULL,
    "candidate" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "measures" JSONB NOT NULL,
    "cases" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentControlAudit" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromValue" JSONB,
    "toValue" JSONB,
    "note" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentControlAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentObservation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "marketplace" TEXT,
    "payload" JSONB NOT NULL,
    "dataVintage" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,

    CONSTRAINT "AgentObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFinding" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "charterVersion" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "marketplace" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "observation" JSONB NOT NULL,
    "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataVintage" TIMESTAMP(3) NOT NULL,
    "proposedTool" TEXT,
    "proposedArgs" JSONB,
    "expectedEffect" JSONB,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dedupeKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPlan" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "marketplace" TEXT,
    "strategyId" TEXT,
    "horizon" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "droppedItems" JSONB NOT NULL,
    "conflicts" JSONB NOT NULL,
    "changeBudget" JSONB NOT NULL,
    "blastRadius" JSONB NOT NULL,
    "criticVerdict" TEXT,
    "criticNotes" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AgentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStrategy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "northStar" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "objectives" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "allocations" JSONB NOT NULL,
    "watchlist" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStep" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spanId" TEXT,
    "parentSpanId" TEXT,
    "input" JSONB,
    "output" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExemplar" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "situation" JSONB NOT NULL,
    "proposal" JSONB NOT NULL,
    "operatorNote" TEXT,
    "correctedArgs" JSONB,
    "weight" DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExemplar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentScorecard" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "findings" INTEGER NOT NULL DEFAULT 0,
    "promoted" INTEGER NOT NULL DEFAULT 0,
    "approved" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "executed" INTEGER NOT NULL DEFAULT 0,
    "rolledBack" INTEGER NOT NULL DEFAULT 0,
    "acceptanceRate" DECIMAL(5,4),
    "calibrationError" DECIMAL(6,4),
    "realisedImpactCents" INTEGER,
    "shadowAgreement" DECIMAL(5,4),
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "costPerAcceptedAction" DECIMAL(12,6),
    "grade" TEXT,
    "promotionEligible" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AgentScorecard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEdge" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "weight" DECIMAL(10,4),
    "properties" JSONB,
    "source" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFleetState" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "halted" BOOLEAN NOT NULL DEFAULT false,
    "haltedAt" TIMESTAMP(3),
    "haltReason" TEXT,
    "haltedBy" TEXT,
    "dailyCeilingUSD" DECIMAL(12,6) NOT NULL DEFAULT 2.00,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFleetState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentShadowGrade" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "engineKey" TEXT NOT NULL,
    "engineProposal" JSONB NOT NULL,
    "agrees" BOOLEAN NOT NULL,
    "disagreementReason" TEXT,
    "gradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentShadowGrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWorkflow" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'builtin',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWorkflowRevision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "AgentWorkflowRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAssignment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetKind" TEXT,
    "targetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wantBack" TEXT,
    "dueAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'not_started',
    "closeNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AgentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFindingRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "findingId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentFindingRun_pkey" PRIMARY KEY ("findingId","runId")
);

-- CreateTable
CREATE TABLE "AdsHarvestPolicy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scopeGrain" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '*',
    "kind" TEXT NOT NULL DEFAULT 'graduate',
    "minOrders" INTEGER NOT NULL,
    "minClicks" INTEGER NOT NULL,
    "maxAcosPct" INTEGER,
    "windowDays" INTEGER NOT NULL,
    "excludeExactMatched" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "AdsHarvestPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsHarvestDestination" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "scopeGrain" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '*',
    "matchType" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "negateAtSource" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "AdsHarvestDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SqpReportRequest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "reportPeriod" TEXT NOT NULL DEFAULT 'WEEK',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "reportDocumentId" TEXT,
    "rowsParsed" INTEGER,
    "rowsUpserted" INTEGER,
    "rowsChanged" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SqpReportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSpendCeiling" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "grain" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dailyCapCents" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpendCeiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdBidPolicy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "grain" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minBidCents" INTEGER,
    "maxBidCents" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdBidPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdWriteRefusal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "deniedAt" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "marketplace" TEXT,
    "campaignId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "payloadValueCents" INTEGER NOT NULL,
    "queueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdWriteRefusal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRefusalDaily" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "dayUtc" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "lastReason" TEXT NOT NULL,
    "lastEntityType" TEXT,
    "lastEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRefusalDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordBidProposal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "requestedBidCents" INTEGER NOT NULL,
    "matchedTargets" INTEGER NOT NULL,
    "matchedCampaigns" INTEGER NOT NULL,
    "actionableTargets" INTEGER NOT NULL,
    "actionableCampaigns" INTEGER NOT NULL,
    "excludedByReason" JSONB NOT NULL,
    "targetIds" JSONB NOT NULL,
    "commitmentCents" INTEGER NOT NULL,
    "ceilingVerdict" TEXT NOT NULL,
    "ceilingGrain" TEXT,
    "ceilingScopeId" TEXT,
    "ceilingCapCents" INTEGER,
    "ceilingMessage" TEXT NOT NULL,
    "committedCents" INTEGER NOT NULL DEFAULT 0,
    "shareAgeDays" INTEGER,
    "confirmationText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "proposedBy" TEXT,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "executionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordBidProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventOutbox" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "context" TEXT NOT NULL,
    "accountId" TEXT,
    "subject" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryChannelMapping" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT '*',
    "channelCategoryId" TEXT NOT NULL,
    "channelCategoryPath" TEXT,
    "browseNodeId" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'MANUAL',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryChannelMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CellFormula" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT '',
    "marketplace" TEXT NOT NULL DEFAULT '',
    "locale" TEXT NOT NULL DEFAULT '',
    "channelConnectionId" TEXT NOT NULL DEFAULT '',
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "fieldKey" TEXT NOT NULL,
    "expr" TEXT NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "market" TEXT,
    "lastError" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CellFormula_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterFieldRule" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productType" TEXT NOT NULL DEFAULT '*',
    "fieldKey" TEXT NOT NULL,
    "expr" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterFieldRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterFieldRuleRevision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MasterFieldRuleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "automationResumedAt" TIMESTAMP(3),
    "isLegacy" BOOLEAN NOT NULL DEFAULT false,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "creationKey" TEXT NOT NULL,
    "creationFingerprint" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMemberRole" (
    "membershipId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "WorkspaceMemberRole_pkey" PRIMARY KEY ("membershipId","roleId")
);

-- CreateTable
CREATE TABLE "WorkspaceInvitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleIds" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceAudit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAccountOwnership" (
    "channelType" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "externalAccountId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "ChannelAccountOwnership_pkey" PRIMARY KEY ("channelType","environment","externalAccountId")
);

-- CreateTable
CREATE TABLE "WorkspaceMemberAccountLimit" (
    "membershipId" TEXT NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMemberAccountLimit_pkey" PRIMARY KEY ("membershipId")
);

-- CreateTable
CREATE TABLE "WorkspaceMemberAccount" (
    "membershipId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMemberAccount_pkey" PRIMARY KEY ("membershipId","connectionId")
);

-- CreateTable
CREATE TABLE "ChannelListingClaim" (
    "connectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sellerSku" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelListingId" TEXT,
    "claimedByUserId" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelListingClaim_pkey" PRIMARY KEY ("connectionId","marketplace","sellerSku")
);

-- CreateTable
CREATE TABLE "ChannelAccountGrant" (
    "connectionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerWorkspaceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'read',
    "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "ChannelAccountGrant_pkey" PRIMARY KEY ("connectionId","workspaceId")
);

-- CreateTable
CREATE TABLE "Assortment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "selection" TEXT NOT NULL DEFAULT 'list',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assortment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssortmentMember" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "assortmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'include',
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssortmentMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssortmentShare" (
    "id" TEXT NOT NULL,
    "assortmentId" TEXT NOT NULL,
    "ownerWorkspaceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fieldGroups" TEXT[],
    "followSettings" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedByUserId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "pausedByUserId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "endedBySide" TEXT,
    "endedByUserId" TEXT,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssortmentShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogLink" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "sourceWorkspaceId" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "targetWorkspaceId" TEXT NOT NULL,
    "targetProductId" TEXT NOT NULL,
    "linkedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceVersion" INTEGER NOT NULL,
    "appliedState" JSONB,
    "overrides" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heldSku" TEXT,
    "heldReason" TEXT,
    "heldAt" TIMESTAMP(3),
    "syncMarket" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detachedAt" TIMESTAMP(3),
    "detachedReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssortmentChange" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "sourceWorkspaceId" TEXT NOT NULL,
    "targetWorkspaceId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reasons" TEXT[],
    "sourceVersion" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssortmentChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssortmentCopyRun" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'preparing',
    "reviewFingerprint" TEXT NOT NULL,
    "skuChoices" JSONB NOT NULL,
    "plan" JSONB NOT NULL,
    "definitionsCreated" JSONB,
    "transferJobId" TEXT,
    "counts" JSONB,
    "error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AssortmentCopyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPoolGrant" (
    "id" TEXT NOT NULL,
    "ownerWorkspaceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "locationIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedByUserId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "pausedByUserId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "endedBySide" TEXT,
    "endedByUserId" TEXT,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockPoolGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPoolLink" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "catalogLinkId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedByUserId" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockPoolLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtsyReceiptIngest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT date_trunc('second'::text, clock_timestamp()),
    "cursorUpdatedAt" TIMESTAMP(3),
    "cursorReceiptId" TEXT,
    "scanUpdatedAt" TIMESTAMP(3),
    "scanCreatedThrough" TIMESTAMP(3),
    "scanExpectedCount" INTEGER,
    "scanOffset" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastPollStartedAt" TIMESTAMP(3),
    "lastPollSucceededAt" TIMESTAMP(3),
    "lastPollStatus" TEXT,
    "lastPollError" TEXT,
    "backlog" BOOLEAN NOT NULL DEFAULT false,
    "lastPollCounts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EtsyReceiptIngest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtsyReceiptRefusal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "receiptVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EtsyReceiptRefusal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPoolTask" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "movementId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "StockPoolTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAccountRoute" (
    "connectionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "destinationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inboundAliases" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ChannelAccountRoute_pkey" PRIMARY KEY ("connectionId")
);

-- CreateTable
CREATE TABLE "ChannelListingTranslation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "bulletPoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "follows" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelListingTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadinessIndex" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "coordinateKey" TEXT NOT NULL,
    "channel" TEXT,
    "market" TEXT,
    "accountId" TEXT,
    "aliasId" TEXT,
    "language" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pct" INTEGER,
    "state" TEXT NOT NULL,
    "requiredFilled" INTEGER NOT NULL,
    "requiredTotal" INTEGER NOT NULL,
    "missing" JSONB NOT NULL,
    "optionalFilled" INTEGER,
    "optionalTotal" INTEGER,
    "optionalMissing" JSONB,
    "note" TEXT,
    "mappingRules" INTEGER,
    "variationSource" TEXT,
    "sortTitle" TEXT,
    "sortDescription" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "pendingSince" TIMESTAMP(3),

    CONSTRAINT "ReadinessIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelDrift" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "driftedFields" JSONB NOT NULL DEFAULT '[]',
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "checkedBySource" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelDrift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerReferenceLabel" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "labels" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerReferenceLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "OAuthGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAuthorizationCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "parentId" TEXT,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyColourProduct" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'GLOBAL',
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "splitAxis" TEXT NOT NULL,
    "valueKey" TEXT NOT NULL,
    "colourName" TEXT,
    "shopifyProductId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'NOT_FOUND',
    "proposal" JSONB,
    "remoteStatus" TEXT,
    "checkedAt" TIMESTAMP(3),
    "linkVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyColourProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyColourSync" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'GLOBAL',
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyColourSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_gtin_idx" ON "Product"("gtin");

-- CreateIndex
CREATE INDEX "Product_abcClass_idx" ON "Product"("abcClass");

-- CreateIndex
CREATE INDEX "Product_deletedAt_idx" ON "Product"("deletedAt");

-- CreateIndex
CREATE INDEX "Product_status_deletedAt_idx" ON "Product"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "Product_brand_idx" ON "Product"("brand");

-- CreateIndex
CREATE INDEX "Product_productType_idx" ON "Product"("productType");

-- CreateIndex
CREATE INDEX "Product_parentId_idx" ON "Product"("parentId");

-- CreateIndex
CREATE INDEX "Product_isParent_idx" ON "Product"("isParent");

-- CreateIndex
CREATE INDEX "Product_fulfillmentMethod_idx" ON "Product"("fulfillmentMethod");

-- CreateIndex
CREATE INDEX "Product_familyId_idx" ON "Product"("familyId");

-- CreateIndex
CREATE INDEX "Product_workflowStageId_idx" ON "Product"("workflowStageId");

-- CreateIndex
CREATE INDEX "Product_parentId_deletedAt_updatedAt_idx" ON "Product"("parentId", "deletedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Product_brand_basePrice_sku_idx" ON "Product"("brand", "basePrice" DESC, "sku");

-- CreateIndex
CREATE INDEX "Product_workspaceId_idx" ON "Product"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_workspace_sku_key" ON "Product"("workspaceId", "sku");

-- CreateIndex
CREATE INDEX "SkuAlias_productId_idx" ON "SkuAlias"("productId");

-- CreateIndex
CREATE INDEX "SkuAlias_workspaceId_idx" ON "SkuAlias"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SkuAlias_workspace_alias_key" ON "SkuAlias"("workspaceId", "alias");

-- CreateIndex
CREATE INDEX "StockImportJob_status_createdAt_idx" ON "StockImportJob"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "StockImportJob_locationCode_idx" ON "StockImportJob"("locationCode");

-- CreateIndex
CREATE INDEX "StockImportJob_workspaceId_idx" ON "StockImportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductFamily_parentFamilyId_idx" ON "ProductFamily"("parentFamilyId");

-- CreateIndex
CREATE INDEX "ProductFamily_workflowId_idx" ON "ProductFamily"("workflowId");

-- CreateIndex
CREATE INDEX "ProductFamily_workspaceId_idx" ON "ProductFamily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductFamily_workspace_code_key" ON "ProductFamily"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "AttributeGroup_workspaceId_idx" ON "AttributeGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeGroup_workspace_code_key" ON "AttributeGroup"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "CustomAttribute_groupId_idx" ON "CustomAttribute"("groupId");

-- CreateIndex
CREATE INDEX "CustomAttribute_workspaceId_idx" ON "CustomAttribute"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomAttribute_workspace_code_key" ON "CustomAttribute"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CustomAttribute_workspace_semanticKey_key" ON "CustomAttribute"("workspaceId", "semanticKey");

-- CreateIndex
CREATE INDEX "AttributeOption_attributeId_idx" ON "AttributeOption"("attributeId");

-- CreateIndex
CREATE INDEX "AttributeOption_workspaceId_idx" ON "AttributeOption"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeOption_attributeId_code_key" ON "AttributeOption"("workspaceId", "attributeId", "code");

-- CreateIndex
CREATE INDEX "FamilyAttribute_familyId_idx" ON "FamilyAttribute"("familyId");

-- CreateIndex
CREATE INDEX "FamilyAttribute_attributeId_idx" ON "FamilyAttribute"("attributeId");

-- CreateIndex
CREATE INDEX "FamilyAttribute_workspaceId_idx" ON "FamilyAttribute"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyAttribute_familyId_attributeId_key" ON "FamilyAttribute"("workspaceId", "familyId", "attributeId");

-- CreateIndex
CREATE INDEX "ProductWorkflow_workspaceId_idx" ON "ProductWorkflow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductWorkflow_workspace_code_key" ON "ProductWorkflow"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "WorkflowStage_workflowId_idx" ON "WorkflowStage"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowStage_workspaceId_idx" ON "WorkflowStage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStage_workflowId_code_key" ON "WorkflowStage"("workspaceId", "workflowId", "code");

-- CreateIndex
CREATE INDEX "WorkflowTransition_productId_createdAt_idx" ON "WorkflowTransition"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowTransition_toStageId_idx" ON "WorkflowTransition"("toStageId");

-- CreateIndex
CREATE INDEX "WorkflowTransition_workspaceId_idx" ON "WorkflowTransition"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowComment_productId_createdAt_idx" ON "WorkflowComment"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowComment_stageId_idx" ON "WorkflowComment"("stageId");

-- CreateIndex
CREATE INDEX "WorkflowComment_workspaceId_idx" ON "WorkflowComment"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_productId_idx" ON "WorkflowAssignment"("productId");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_stageId_idx" ON "WorkflowAssignment"("stageId");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_assigneeId_idx" ON "WorkflowAssignment"("assigneeId");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_workspaceId_idx" ON "WorkflowAssignment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAssignment_productId_assigneeId_role_key" ON "WorkflowAssignment"("workspaceId", "productId", "assigneeId", "role");

-- CreateIndex
CREATE INDEX "CustomerGroup_workspaceId_idx" ON "CustomerGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroup_workspace_code_key" ON "CustomerGroup"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "ProductTierPrice_productId_idx" ON "ProductTierPrice"("productId");

-- CreateIndex
CREATE INDEX "ProductTierPrice_customerGroupId_idx" ON "ProductTierPrice"("customerGroupId");

-- CreateIndex
CREATE INDEX "ProductTierPrice_workspaceId_idx" ON "ProductTierPrice"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTierPrice_productId_minQty_customerGroupId_key" ON "ProductTierPrice"("workspaceId", "productId", "minQty", "customerGroupId");

-- CreateIndex
CREATE INDEX "DigitalAsset_type_idx" ON "DigitalAsset"("type");

-- CreateIndex
CREATE INDEX "DigitalAsset_folderId_idx" ON "DigitalAsset"("folderId");

-- CreateIndex
CREATE INDEX "DigitalAsset_workspaceId_idx" ON "DigitalAsset"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalAsset_workspace_code_key" ON "DigitalAsset"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalAsset_workspace_contentHash_key" ON "DigitalAsset"("workspaceId", "contentHash");

-- CreateIndex
CREATE INDEX "AssetFolder_parentId_order_idx" ON "AssetFolder"("parentId", "order");

-- CreateIndex
CREATE INDEX "AssetFolder_workspaceId_idx" ON "AssetFolder"("workspaceId");

-- CreateIndex
CREATE INDEX "AssetUsage_assetId_idx" ON "AssetUsage"("assetId");

-- CreateIndex
CREATE INDEX "AssetUsage_scope_productId_idx" ON "AssetUsage"("scope", "productId");

-- CreateIndex
CREATE INDEX "AssetUsage_productId_idx" ON "AssetUsage"("productId");

-- CreateIndex
CREATE INDEX "AssetUsage_workspaceId_idx" ON "AssetUsage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetUsage_assetId_scope_productId_role_sortOrder_key" ON "AssetUsage"("workspaceId", "assetId", "scope", "productId", "role", "sortOrder");

-- CreateIndex
CREATE INDEX "RepricingRule_productId_idx" ON "RepricingRule"("productId");

-- CreateIndex
CREATE INDEX "RepricingRule_channel_marketplace_idx" ON "RepricingRule"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "RepricingRule_enabled_idx" ON "RepricingRule"("enabled");

-- CreateIndex
CREATE INDEX "RepricingRule_workspaceId_idx" ON "RepricingRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RepricingRule_productId_channel_marketplace_key" ON "RepricingRule"("workspaceId", "productId", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "RepricingDecision_ruleId_createdAt_idx" ON "RepricingDecision"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "RepricingDecision_workspaceId_idx" ON "RepricingDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductVariation_productId_idx" ON "ProductVariation"("productId");

-- CreateIndex
CREATE INDEX "ProductVariation_workspaceId_idx" ON "ProductVariation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariation_workspace_sku_key" ON "ProductVariation"("workspaceId", "sku");

-- CreateIndex
CREATE INDEX "VariantImage_variantId_idx" ON "VariantImage"("variantId");

-- CreateIndex
CREATE INDEX "VariantImage_workspaceId_idx" ON "VariantImage"("workspaceId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_variantId_idx" ON "VariantChannelListing"("variantId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_channelId_idx" ON "VariantChannelListing"("channelId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_channelConnectionId_idx" ON "VariantChannelListing"("channelConnectionId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_externalListingId_idx" ON "VariantChannelListing"("externalListingId");

-- CreateIndex
CREATE INDEX "VariantChannelListing_marketplace_idx" ON "VariantChannelListing"("marketplace");

-- CreateIndex
CREATE INDEX "VariantChannelListing_channel_marketplace_listingStatus_idx" ON "VariantChannelListing"("channel", "marketplace", "listingStatus");

-- CreateIndex
CREATE INDEX "VariantChannelListing_workspaceId_idx" ON "VariantChannelListing"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantChannelListing_variantId_channelId_key" ON "VariantChannelListing"("workspaceId", "variantId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantChannelListing_variantId_channel_marketplace_conn_key" ON "VariantChannelListing"("workspaceId", "variantId", "channel", "marketplace", "channelConnectionId");

-- CreateIndex
CREATE INDEX "ChannelListing_aliasId_idx" ON "ChannelListing"("aliasId");

-- CreateIndex
CREATE INDEX "ChannelListing_channelConnectionId_idx" ON "ChannelListing"("channelConnectionId");

-- CreateIndex
CREATE INDEX "ChannelListing_productId_idx" ON "ChannelListing"("productId");

-- CreateIndex
CREATE INDEX "ChannelListing_channel_idx" ON "ChannelListing"("channel");

-- CreateIndex
CREATE INDEX "ChannelListing_region_idx" ON "ChannelListing"("region");

-- CreateIndex
CREATE INDEX "ChannelListing_marketplace_idx" ON "ChannelListing"("marketplace");

-- CreateIndex
CREATE INDEX "ChannelListing_externalListingId_idx" ON "ChannelListing"("externalListingId");

-- CreateIndex
CREATE INDEX "ChannelListing_listingStatus_idx" ON "ChannelListing"("listingStatus");

-- CreateIndex
CREATE INDEX "ChannelListing_syncStatus_idx" ON "ChannelListing"("syncStatus");

-- CreateIndex
CREATE INDEX "ChannelListing_validationStatus_idx" ON "ChannelListing"("validationStatus");

-- CreateIndex
CREATE INDEX "ChannelListing_channel_marketplace_listingStatus_idx" ON "ChannelListing"("channel", "marketplace", "listingStatus");

-- CreateIndex
CREATE INDEX "ChannelListing_workspaceId_idx" ON "ChannelListing"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelListing_productId_channelMarket_akey_key" ON "ChannelListing"("workspaceId", "productId", "channelMarket", "channelConnectionId", "aliasKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelListing_productId_channel_marketplace_akey_key" ON "ChannelListing"("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "aliasKey");

-- CreateIndex
CREATE INDEX "ProductListingAlias_productId_idx" ON "ProductListingAlias"("productId");

-- CreateIndex
CREATE INDEX "ProductListingAlias_channel_marketplace_idx" ON "ProductListingAlias"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "ProductListingAlias_channelConnectionId_idx" ON "ProductListingAlias"("channelConnectionId");

-- CreateIndex
CREATE INDEX "ProductListingAlias_workspaceId_idx" ON "ProductListingAlias"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductListingAlias_coord_position_key" ON "ProductListingAlias"("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "position");

-- CreateIndex
CREATE INDEX "ChannelListingSnapshot_channelListingId_createdAt_idx" ON "ChannelListingSnapshot"("channelListingId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelListingSnapshot_publishEventId_idx" ON "ChannelListingSnapshot"("publishEventId");

-- CreateIndex
CREATE INDEX "ChannelListingSnapshot_channel_marketplace_idx" ON "ChannelListingSnapshot"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "ChannelListingSnapshot_workspaceId_idx" ON "ChannelListingSnapshot"("workspaceId");

-- CreateIndex
CREATE INDEX "Marketplace_channel_idx" ON "Marketplace"("channel");

-- CreateIndex
CREATE INDEX "Marketplace_workspaceId_idx" ON "Marketplace"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Marketplace_channel_code_key" ON "Marketplace"("workspaceId", "channel", "code");

-- CreateIndex
CREATE INDEX "ChannelListingOverride_channelListingId_idx" ON "ChannelListingOverride"("channelListingId");

-- CreateIndex
CREATE INDEX "ChannelListingOverride_fieldName_idx" ON "ChannelListingOverride"("fieldName");

-- CreateIndex
CREATE INDEX "ChannelListingOverride_isActive_idx" ON "ChannelListingOverride"("isActive");

-- CreateIndex
CREATE INDEX "ChannelListingOverride_workspaceId_idx" ON "ChannelListingOverride"("workspaceId");

-- CreateIndex
CREATE INDEX "FieldLinkGroup_productId_idx" ON "FieldLinkGroup"("productId");

-- CreateIndex
CREATE INDEX "FieldLinkGroup_productId_fieldKey_idx" ON "FieldLinkGroup"("productId", "fieldKey");

-- CreateIndex
CREATE INDEX "FieldLinkGroup_productId_fieldKey_variantId_idx" ON "FieldLinkGroup"("productId", "fieldKey", "variantId");

-- CreateIndex
CREATE INDEX "FieldLinkGroup_workspaceId_idx" ON "FieldLinkGroup"("workspaceId");

-- CreateIndex
CREATE INDEX "FieldValueMap_channel_marketplace_attribute_idx" ON "FieldValueMap"("channel", "marketplace", "attribute");

-- CreateIndex
CREATE INDEX "FieldValueMap_workspaceId_idx" ON "FieldValueMap"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldValueMap_channel_marketplace_attribute_fromValue_key" ON "FieldValueMap"("workspaceId", "channel", "marketplace", "attribute", "fromValue");

-- CreateIndex
CREATE INDEX "SizeScaleMap_scale_fromSystem_toSystem_idx" ON "SizeScaleMap"("scale", "fromSystem", "toSystem");

-- CreateIndex
CREATE INDEX "SizeScaleMap_workspaceId_idx" ON "SizeScaleMap"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SizeScaleMap_scale_fromSystem_toSystem_fromValue_key" ON "SizeScaleMap"("workspaceId", "scale", "fromSystem", "toSystem", "fromValue");

-- CreateIndex
CREATE INDEX "MappingRevision_channel_code_idx" ON "MappingRevision"("channel", "code");

-- CreateIndex
CREATE INDEX "MappingRevision_workspaceId_idx" ON "MappingRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MappingRevision_channel_code_version_key" ON "MappingRevision"("workspaceId", "channel", "code", "version");

-- CreateIndex
CREATE INDEX "SyncAttempt_listingId_attemptedAt_idx" ON "SyncAttempt"("listingId", "attemptedAt");

-- CreateIndex
CREATE INDEX "SyncAttempt_status_idx" ON "SyncAttempt"("status");

-- CreateIndex
CREATE INDEX "SyncAttempt_source_idx" ON "SyncAttempt"("source");

-- CreateIndex
CREATE INDEX "SyncAttempt_workspaceId_idx" ON "SyncAttempt"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonSuppression_listingId_suppressedAt_idx" ON "AmazonSuppression"("listingId", "suppressedAt");

-- CreateIndex
CREATE INDEX "AmazonSuppression_resolvedAt_idx" ON "AmazonSuppression"("resolvedAt");

-- CreateIndex
CREATE INDEX "AmazonSuppression_workspaceId_idx" ON "AmazonSuppression"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingIssue_listingId_resolvedAt_idx" ON "ListingIssue"("listingId", "resolvedAt");

-- CreateIndex
CREATE INDEX "ListingIssue_severity_idx" ON "ListingIssue"("severity");

-- CreateIndex
CREATE INDEX "ListingIssue_workspaceId_idx" ON "ListingIssue"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingIssue_listingId_fingerprint_key" ON "ListingIssue"("workspaceId", "listingId", "fingerprint");

-- CreateIndex
CREATE INDEX "Offer_channelListingId_idx" ON "Offer"("channelListingId");

-- CreateIndex
CREATE INDEX "Offer_fulfillmentMethod_idx" ON "Offer"("fulfillmentMethod");

-- CreateIndex
CREATE INDEX "Offer_isActive_idx" ON "Offer"("isActive");

-- CreateIndex
CREATE INDEX "Offer_workspaceId_idx" ON "Offer"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_channelListingId_fulfillmentMethod_key" ON "Offer"("workspaceId", "channelListingId", "fulfillmentMethod");

-- CreateIndex
CREATE INDEX "ListingRecoveryEvent_productId_idx" ON "ListingRecoveryEvent"("productId");

-- CreateIndex
CREATE INDEX "ListingRecoveryEvent_channel_marketplace_idx" ON "ListingRecoveryEvent"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "ListingRecoveryEvent_status_idx" ON "ListingRecoveryEvent"("status");

-- CreateIndex
CREATE INDEX "ListingRecoveryEvent_action_idx" ON "ListingRecoveryEvent"("action");

-- CreateIndex
CREATE INDEX "ListingRecoveryEvent_startedAt_idx" ON "ListingRecoveryEvent"("startedAt");

-- CreateIndex
CREATE INDEX "ListingRecoveryEvent_workspaceId_idx" ON "ListingRecoveryEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelListingImage_productId_idx" ON "ChannelListingImage"("productId");

-- CreateIndex
CREATE INDEX "ChannelListingImage_channelListingId_idx" ON "ChannelListingImage"("channelListingId");

-- CreateIndex
CREATE INDEX "ChannelListingImage_workspaceId_idx" ON "ChannelListingImage"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductImage_derivedFromImageId_idx" ON "ProductImage"("derivedFromImageId");

-- CreateIndex
CREATE INDEX "ProductImage_sameAsImageId_idx" ON "ProductImage"("sameAsImageId");

-- CreateIndex
CREATE INDEX "ProductImage_productId_perceptualHash_idx" ON "ProductImage"("productId", "perceptualHash");

-- CreateIndex
CREATE INDEX "ProductImage_productId_isPrimary_idx" ON "ProductImage"("productId", "isPrimary");

-- CreateIndex
CREATE INDEX "ProductImage_productId_mediaType_sortOrder_idx" ON "ProductImage"("productId", "mediaType", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductImage_workspaceId_idx" ON "ProductImage"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductImage_versionGroupId_idx" ON "ProductImage"("versionGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_productId_contentHash_key" ON "ProductImage"("workspaceId", "productId", "contentHash");

-- CreateIndex
CREATE INDEX "ProductMediaPlan_workspaceId_idx" ON "ProductMediaPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductMediaPlan_productId_idx" ON "ProductMediaPlan"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMediaPlan_workspaceId_productId_layer_channel_market_key" ON "ProductMediaPlan"("workspaceId", "productId", "layer", "channel", "marketplace", "channelConnectionId", "aliasKey");

-- CreateIndex
CREATE INDEX "TerminologyPreference_brand_marketplace_idx" ON "TerminologyPreference"("brand", "marketplace");

-- CreateIndex
CREATE INDEX "TerminologyPreference_marketplace_idx" ON "TerminologyPreference"("marketplace");

-- CreateIndex
CREATE INDEX "TerminologyPreference_workspaceId_idx" ON "TerminologyPreference"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandVoice_brand_marketplace_language_isActive_idx" ON "BrandVoice"("brand", "marketplace", "language", "isActive");

-- CreateIndex
CREATE INDEX "BrandVoice_isActive_idx" ON "BrandVoice"("isActive");

-- CreateIndex
CREATE INDEX "BrandVoice_workspaceId_idx" ON "BrandVoice"("workspaceId");

-- CreateIndex
CREATE INDEX "MarketplaceSync_workspaceId_idx" ON "MarketplaceSync"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceSync_productId_channel_key" ON "MarketplaceSync"("workspaceId", "productId", "channel");

-- CreateIndex
CREATE INDEX "Channel_workspaceId_idx" ON "Channel"("workspaceId");

-- CreateIndex
CREATE INDEX "Listing_workspaceId_idx" ON "Listing"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_productId_channelId_key" ON "Listing"("workspaceId", "productId", "channelId");

-- CreateIndex
CREATE INDEX "DraftListing_productId_idx" ON "DraftListing"("productId");

-- CreateIndex
CREATE INDEX "DraftListing_status_idx" ON "DraftListing"("status");

-- CreateIndex
CREATE INDEX "DraftListing_createdAt_idx" ON "DraftListing"("createdAt");

-- CreateIndex
CREATE INDEX "DraftListing_workspaceId_idx" ON "DraftListing"("workspaceId");

-- CreateIndex
CREATE INDEX "StockLog_workspaceId_idx" ON "StockLog"("workspaceId");

-- CreateIndex
CREATE INDEX "FBAShipment_workspaceId_idx" ON "FBAShipment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FBAShipment_workspace_shipmentId_key" ON "FBAShipment"("workspaceId", "shipmentId");

-- CreateIndex
CREATE INDEX "FBAShipmentItem_workspaceId_idx" ON "FBAShipmentItem"("workspaceId");

-- CreateIndex
CREATE INDEX "PricingRule_workspaceId_idx" ON "PricingRule"("workspaceId");

-- CreateIndex
CREATE INDEX "PricingRuleProduct_ruleId_idx" ON "PricingRuleProduct"("ruleId");

-- CreateIndex
CREATE INDEX "PricingRuleProduct_productId_idx" ON "PricingRuleProduct"("productId");

-- CreateIndex
CREATE INDEX "PricingRuleProduct_workspaceId_idx" ON "PricingRuleProduct"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRuleProduct_ruleId_productId_key" ON "PricingRuleProduct"("workspaceId", "ruleId", "productId");

-- CreateIndex
CREATE INDEX "PricingRuleVariation_ruleId_idx" ON "PricingRuleVariation"("ruleId");

-- CreateIndex
CREATE INDEX "PricingRuleVariation_variationId_idx" ON "PricingRuleVariation"("variationId");

-- CreateIndex
CREATE INDEX "PricingRuleVariation_workspaceId_idx" ON "PricingRuleVariation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRuleVariation_ruleId_variationId_key" ON "PricingRuleVariation"("workspaceId", "ruleId", "variationId");

-- CreateIndex
CREATE INDEX "SyncHealthLog_channel_idx" ON "SyncHealthLog"("channel");

-- CreateIndex
CREATE INDEX "SyncHealthLog_errorType_idx" ON "SyncHealthLog"("errorType");

-- CreateIndex
CREATE INDEX "SyncHealthLog_severity_idx" ON "SyncHealthLog"("severity");

-- CreateIndex
CREATE INDEX "SyncHealthLog_productId_idx" ON "SyncHealthLog"("productId");

-- CreateIndex
CREATE INDEX "SyncHealthLog_variationId_idx" ON "SyncHealthLog"("variationId");

-- CreateIndex
CREATE INDEX "SyncHealthLog_resolutionStatus_idx" ON "SyncHealthLog"("resolutionStatus");

-- CreateIndex
CREATE INDEX "SyncHealthLog_createdAt_idx" ON "SyncHealthLog"("createdAt");

-- CreateIndex
CREATE INDEX "SyncHealthLog_workspaceId_idx" ON "SyncHealthLog"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkActionJob_actionType_idx" ON "BulkActionJob"("actionType");

-- CreateIndex
CREATE INDEX "BulkActionJob_channel_idx" ON "BulkActionJob"("channel");

-- CreateIndex
CREATE INDEX "BulkActionJob_status_idx" ON "BulkActionJob"("status");

-- CreateIndex
CREATE INDEX "BulkActionJob_createdAt_idx" ON "BulkActionJob"("createdAt");

-- CreateIndex
CREATE INDEX "BulkActionJob_completedAt_idx" ON "BulkActionJob"("completedAt");

-- CreateIndex
CREATE INDEX "BulkActionJob_workspaceId_idx" ON "BulkActionJob"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkActionItem_jobId_idx" ON "BulkActionItem"("jobId");

-- CreateIndex
CREATE INDEX "BulkActionItem_jobId_status_idx" ON "BulkActionItem"("jobId", "status");

-- CreateIndex
CREATE INDEX "BulkActionItem_productId_idx" ON "BulkActionItem"("productId");

-- CreateIndex
CREATE INDEX "BulkActionItem_workspaceId_idx" ON "BulkActionItem"("workspaceId");

-- CreateIndex
CREATE INDEX "SellerFeedback_workspaceId_idx" ON "SellerFeedback"("workspaceId");

-- CreateIndex
CREATE INDEX "Campaign_marketplace_status_idx" ON "Campaign"("marketplace", "status");

-- CreateIndex
CREATE INDEX "Campaign_lastSyncStatus_idx" ON "Campaign"("lastSyncStatus");

-- CreateIndex
CREATE INDEX "Campaign_settingsSyncedAt_idx" ON "Campaign"("settingsSyncedAt");

-- CreateIndex
CREATE INDEX "Campaign_adProduct_marketplace_status_idx" ON "Campaign"("adProduct", "marketplace", "status");

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_idx" ON "Campaign"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_externalCampaignId_marketplace_key" ON "Campaign"("workspaceId", "externalCampaignId", "marketplace");

-- CreateIndex
CREATE INDEX "AdGroup_campaignId_status_idx" ON "AdGroup"("campaignId", "status");

-- CreateIndex
CREATE INDEX "AdGroup_orphanedAt_idx" ON "AdGroup"("orphanedAt");

-- CreateIndex
CREATE INDEX "AdGroup_workspaceId_idx" ON "AdGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdGroup_externalAdGroupId_campaignId_key" ON "AdGroup"("workspaceId", "externalAdGroupId", "campaignId");

-- CreateIndex
CREATE INDEX "AdTarget_adGroupId_status_idx" ON "AdTarget"("adGroupId", "status");

-- CreateIndex
CREATE INDEX "AdTarget_externalTargetId_idx" ON "AdTarget"("externalTargetId");

-- CreateIndex
CREATE INDEX "AdTarget_adGroupId_isNegative_idx" ON "AdTarget"("adGroupId", "isNegative");

-- CreateIndex
CREATE INDEX "AdTarget_orphanedAt_idx" ON "AdTarget"("orphanedAt");

-- CreateIndex
CREATE INDEX "AdTarget_workspaceId_idx" ON "AdTarget"("workspaceId");

-- CreateIndex
CREATE INDEX "AdProductAd_productId_idx" ON "AdProductAd"("productId");

-- CreateIndex
CREATE INDEX "AdProductAd_asin_idx" ON "AdProductAd"("asin");

-- CreateIndex
CREATE INDEX "AdProductAd_workspaceId_idx" ON "AdProductAd"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdProductAd_adGroupId_asin_key" ON "AdProductAd"("workspaceId", "adGroupId", "asin");

-- CreateIndex
CREATE INDEX "AdProductSet_channel_marketplace_idx" ON "AdProductSet"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "AdProductSet_workspaceId_idx" ON "AdProductSet"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdProductSet_channel_marketplace_name_key" ON "AdProductSet"("workspaceId", "channel", "marketplace", "name");

-- CreateIndex
CREATE INDEX "AmazonAdsConnection_marketplace_isActive_idx" ON "AmazonAdsConnection"("marketplace", "isActive");

-- CreateIndex
CREATE INDEX "AmazonAdsConnection_tokenExpiresAt_idx" ON "AmazonAdsConnection"("tokenExpiresAt");

-- CreateIndex
CREATE INDEX "AmazonAdsConnection_workspaceId_idx" ON "AmazonAdsConnection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsConnection_workspace_profileId_key" ON "AmazonAdsConnection"("workspaceId", "profileId");

-- CreateIndex
CREATE INDEX "AmazonAdsProfile_countryCode_idx" ON "AmazonAdsProfile"("countryCode");

-- CreateIndex
CREATE INDEX "AmazonAdsProfile_currencyCode_idx" ON "AmazonAdsProfile"("currencyCode");

-- CreateIndex
CREATE INDEX "AmazonAdsProfile_marketplace_idx" ON "AmazonAdsProfile"("marketplace");

-- CreateIndex
CREATE INDEX "AmazonAdsProfile_workspaceId_idx" ON "AmazonAdsProfile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsProfile_workspace_profileId_key" ON "AmazonAdsProfile"("workspaceId", "profileId");

-- CreateIndex
CREATE INDEX "KeywordWatchlist_marketplace_isDefault_idx" ON "KeywordWatchlist"("marketplace", "isDefault");

-- CreateIndex
CREATE INDEX "KeywordWatchlist_workspaceId_idx" ON "KeywordWatchlist"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordWatchlist_marketplace_name_key" ON "KeywordWatchlist"("workspaceId", "marketplace", "name");

-- CreateIndex
CREATE INDEX "KeywordWatchlistTerm_watchlistId_isBranded_idx" ON "KeywordWatchlistTerm"("watchlistId", "isBranded");

-- CreateIndex
CREATE INDEX "KeywordWatchlistTerm_workspaceId_idx" ON "KeywordWatchlistTerm"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordWatchlistTerm_watchlistId_term_key" ON "KeywordWatchlistTerm"("workspaceId", "watchlistId", "term");

-- CreateIndex
CREATE INDEX "KeywordCoverageSet_portfolioId_idx" ON "KeywordCoverageSet"("portfolioId");

-- CreateIndex
CREATE INDEX "KeywordCoverageSet_workspaceId_idx" ON "KeywordCoverageSet"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordCoverageSet_portfolioId_marketplace_name_key" ON "KeywordCoverageSet"("workspaceId", "portfolioId", "marketplace", "name");

-- CreateIndex
CREATE INDEX "KeywordCoverageTerm_setId_status_idx" ON "KeywordCoverageTerm"("setId", "status");

-- CreateIndex
CREATE INDEX "KeywordCoverageTerm_workspaceId_idx" ON "KeywordCoverageTerm"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordCoverageTerm_setId_term_key" ON "KeywordCoverageTerm"("workspaceId", "setId", "term");

-- CreateIndex
CREATE INDEX "AmazonAdsPortfolio_profileId_state_idx" ON "AmazonAdsPortfolio"("profileId", "state");

-- CreateIndex
CREATE INDEX "AmazonAdsPortfolio_workspaceId_idx" ON "AmazonAdsPortfolio"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsPortfolio_profileId_externalPortfolioId_key" ON "AmazonAdsPortfolio"("workspaceId", "profileId", "externalPortfolioId");

-- CreateIndex
CREATE INDEX "AmazonAdsDailyPerformance_profileId_adProduct_date_idx" ON "AmazonAdsDailyPerformance"("profileId", "adProduct", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsDailyPerformance_localEntityId_date_idx" ON "AmazonAdsDailyPerformance"("localEntityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsDailyPerformance_marketplace_date_adProduct_idx" ON "AmazonAdsDailyPerformance"("marketplace", "date", "adProduct");

-- CreateIndex
CREATE INDEX "AmazonAdsDailyPerformance_entityType_entityId_date_idx" ON "AmazonAdsDailyPerformance"("entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsDailyPerformance_workspaceId_idx" ON "AmazonAdsDailyPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsDailyPerformance_profileId_adProduct_entityT_4f88ac473" ON "AmazonAdsDailyPerformance"("workspaceId", "profileId", "adProduct", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyPerformance_localEntityId_date_idx" ON "AmazonAdsHourlyPerformance"("localEntityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyPerformance_mkt_date_hour_idx" ON "AmazonAdsHourlyPerformance"("marketplace", "date", "hour", "adProduct");

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyPerformance_workspaceId_idx" ON "AmazonAdsHourlyPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsHourlyPerformance_entity_date_hour_key" ON "AmazonAdsHourlyPerformance"("workspaceId", "profileId", "adProduct", "entityType", "entityId", "date", "hour");

-- CreateIndex
CREATE INDEX "AdBudgetUsageSample_campaign_reading_idx" ON "AdBudgetUsageSample"("campaignId", "usageUpdatedAt");

-- CreateIndex
CREATE INDEX "AdBudgetUsageSample_lastSeenAt_idx" ON "AdBudgetUsageSample"("lastSeenAt");

-- CreateIndex
CREATE INDEX "AdBudgetUsageSample_workspaceId_idx" ON "AdBudgetUsageSample"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdBudgetUsageSample_reading_key" ON "AdBudgetUsageSample"("workspaceId", "campaignId", "source", "usageUpdatedAt");

-- CreateIndex
CREATE INDEX "AmazonAdsSearchTerm_profileId_date_idx" ON "AmazonAdsSearchTerm"("profileId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSearchTerm_campaignId_date_idx" ON "AmazonAdsSearchTerm"("campaignId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSearchTerm_profileId_query_idx" ON "AmazonAdsSearchTerm"("profileId", "query");

-- CreateIndex
CREATE INDEX "AmazonAdsSearchTerm_workspaceId_idx" ON "AmazonAdsSearchTerm"("workspaceId");

-- CreateIndex
CREATE INDEX "SearchQueryPerformance_marketplace_startDate_idx" ON "SearchQueryPerformance"("marketplace", "startDate");

-- CreateIndex
CREATE INDEX "SearchQueryPerformance_searchQuery_idx" ON "SearchQueryPerformance"("searchQuery");

-- CreateIndex
CREATE INDEX "SearchQueryPerformance_asin_startDate_idx" ON "SearchQueryPerformance"("asin", "startDate");

-- CreateIndex
CREATE INDEX "SearchQueryPerformance_workspaceId_idx" ON "SearchQueryPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchQueryPerformance_marketplace_reportPeriod_start_669db0493" ON "SearchQueryPerformance"("workspaceId", "marketplace", "reportPeriod", "startDate", "searchQuery", "asin");

-- CreateIndex
CREATE INDEX "AmazonAdsPlacementReport_profileId_adProduct_date_idx" ON "AmazonAdsPlacementReport"("profileId", "adProduct", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsPlacementReport_workspaceId_idx" ON "AmazonAdsPlacementReport"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsPlacementReport_campaignId_date_placement_key" ON "AmazonAdsPlacementReport"("workspaceId", "campaignId", "date", "placement");

-- CreateIndex
CREATE INDEX "DataKioskQueryJob_status_lastPolledAt_idx" ON "DataKioskQueryJob"("status", "lastPolledAt");

-- CreateIndex
CREATE INDEX "DataKioskQueryJob_queryType_marketplaceId_startDate_idx" ON "DataKioskQueryJob"("queryType", "marketplaceId", "startDate");

-- CreateIndex
CREATE INDEX "DataKioskQueryJob_externalQueryId_idx" ON "DataKioskQueryJob"("externalQueryId");

-- CreateIndex
CREATE INDEX "DataKioskQueryJob_workspaceId_idx" ON "DataKioskQueryJob"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonEconomicsDaily_marketplace_date_idx" ON "AmazonEconomicsDaily"("marketplace", "date");

-- CreateIndex
CREATE INDEX "AmazonEconomicsDaily_childAsin_date_idx" ON "AmazonEconomicsDaily"("childAsin", "date");

-- CreateIndex
CREATE INDEX "AmazonEconomicsDaily_msku_date_idx" ON "AmazonEconomicsDaily"("msku", "date");

-- CreateIndex
CREATE INDEX "AmazonEconomicsDaily_workspaceId_idx" ON "AmazonEconomicsDaily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonEconomicsDaily_marketplaceId_date_childAsin_msku_key" ON "AmazonEconomicsDaily"("workspaceId", "marketplaceId", "date", "childAsin", "msku");

-- CreateIndex
CREATE INDEX "AmazonAdsBrandMetric_workspaceId_idx" ON "AmazonAdsBrandMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsBrandMetric_profileId_brandName_date_key" ON "AmazonAdsBrandMetric"("workspaceId", "profileId", "brandName", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsBrandBuildingMetric_profileId_computationDate_idx" ON "AmazonAdsBrandBuildingMetric"("profileId", "computationDate");

-- CreateIndex
CREATE INDEX "AmazonAdsBrandBuildingMetric_marketplace_computationDate_idx" ON "AmazonAdsBrandBuildingMetric"("marketplace", "computationDate");

-- CreateIndex
CREATE INDEX "AmazonAdsBrandBuildingMetric_workspaceId_idx" ON "AmazonAdsBrandBuildingMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsBrandBuildingMetric_profileId_brandName_comp_d39fe70dc" ON "AmazonAdsBrandBuildingMetric"("workspaceId", "profileId", "brandName", "computationDate", "lookbackPeriod", "categoryNodeName");

-- CreateIndex
CREATE INDEX "AmazonAdsReportJob_status_lastPolledAt_idx" ON "AmazonAdsReportJob"("status", "lastPolledAt");

-- CreateIndex
CREATE INDEX "AmazonAdsReportJob_ingestedAt_completedAt_idx" ON "AmazonAdsReportJob"("ingestedAt", "completedAt");

-- CreateIndex
CREATE INDEX "AmazonAdsReportJob_profileId_adProduct_createdAt_idx" ON "AmazonAdsReportJob"("profileId", "adProduct", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonAdsReportJob_externalReportId_idx" ON "AmazonAdsReportJob"("externalReportId");

-- CreateIndex
CREATE INDEX "AmazonAdsReportJob_workspaceId_idx" ON "AmazonAdsReportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonAdsExportJob_status_lastPolledAt_idx" ON "AmazonAdsExportJob"("status", "lastPolledAt");

-- CreateIndex
CREATE INDEX "AmazonAdsExportJob_profileId_resource_createdAt_idx" ON "AmazonAdsExportJob"("profileId", "resource", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonAdsExportJob_externalExportId_idx" ON "AmazonAdsExportJob"("externalExportId");

-- CreateIndex
CREATE INDEX "AmazonAdsExportJob_workspaceId_idx" ON "AmazonAdsExportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "FbaStorageAge_productId_marketplace_idx" ON "FbaStorageAge"("productId", "marketplace");

-- CreateIndex
CREATE INDEX "FbaStorageAge_marketplace_daysToLtsThreshold_idx" ON "FbaStorageAge"("marketplace", "daysToLtsThreshold");

-- CreateIndex
CREATE INDEX "FbaStorageAge_workspaceId_idx" ON "FbaStorageAge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaStorageAge_sku_marketplace_polledAt_key" ON "FbaStorageAge"("workspaceId", "sku", "marketplace", "polledAt");

-- CreateIndex
CREATE INDEX "ProductProfitDaily_marketplace_date_idx" ON "ProductProfitDaily"("marketplace", "date");

-- CreateIndex
CREATE INDEX "ProductProfitDaily_trueProfitMarginPct_idx" ON "ProductProfitDaily"("trueProfitMarginPct");

-- CreateIndex
CREATE INDEX "ProductProfitDaily_workspaceId_idx" ON "ProductProfitDaily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductProfitDaily_productId_marketplace_date_key" ON "ProductProfitDaily"("workspaceId", "productId", "marketplace", "date");

-- CreateIndex
CREATE INDEX "AdDrift_classification_lastDetectedAt_idx" ON "AdDrift"("classification", "lastDetectedAt" DESC);

-- CreateIndex
CREATE INDEX "AdDrift_resolvedAt_lastDetectedAt_idx" ON "AdDrift"("resolvedAt", "lastDetectedAt" DESC);

-- CreateIndex
CREATE INDEX "AdDrift_entityType_entityId_idx" ON "AdDrift"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AdDrift_workspaceId_idx" ON "AdDrift"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdDrift_entityType_entityId_field_key" ON "AdDrift"("workspaceId", "entityType", "entityId", "field");

-- CreateIndex
CREATE INDEX "AdvertisingActionLog_executionId_createdAt_idx" ON "AdvertisingActionLog"("executionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdvertisingActionLog_entityType_entityId_createdAt_idx" ON "AdvertisingActionLog"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdvertisingActionLog_createdAt_idx" ON "AdvertisingActionLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdvertisingActionLog_userId_createdAt_idx" ON "AdvertisingActionLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdvertisingActionLog_workspaceId_idx" ON "AdvertisingActionLog"("workspaceId");

-- CreateIndex
CREATE INDEX "BudgetPool_enabled_lastRebalancedAt_idx" ON "BudgetPool"("enabled", "lastRebalancedAt");

-- CreateIndex
CREATE INDEX "BudgetPool_workspaceId_idx" ON "BudgetPool"("workspaceId");

-- CreateIndex
CREATE INDEX "BudgetPoolAllocation_budgetPoolId_idx" ON "BudgetPoolAllocation"("budgetPoolId");

-- CreateIndex
CREATE INDEX "BudgetPoolAllocation_marketplace_idx" ON "BudgetPoolAllocation"("marketplace");

-- CreateIndex
CREATE INDEX "BudgetPoolAllocation_workspaceId_idx" ON "BudgetPoolAllocation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPoolAllocation_budgetPoolId_marketplace_campaignId_key" ON "BudgetPoolAllocation"("workspaceId", "budgetPoolId", "marketplace", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPoolAllocation_campaignId_key" ON "BudgetPoolAllocation"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "BudgetPoolRebalance_budgetPoolId_createdAt_idx" ON "BudgetPoolRebalance"("budgetPoolId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BudgetPoolRebalance_workspaceId_idx" ON "BudgetPoolRebalance"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignBidHistory_entityType_entityId_changedAt_idx" ON "CampaignBidHistory"("entityType", "entityId", "changedAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignBidHistory_campaignId_idx" ON "CampaignBidHistory"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignBidHistory_workspaceId_idx" ON "CampaignBidHistory"("workspaceId");

-- CreateIndex
CREATE INDEX "Coupon_workspaceId_idx" ON "Coupon"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSettings_workspaceId_key" ON "AccountSettings"("workspaceId");

-- CreateIndex
CREATE INDEX "NotificationPreference_userId_idx" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "NotificationPreference_workspaceId_idx" ON "NotificationPreference"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_eventType_key" ON "NotificationPreference"("workspaceId", "userId", "eventType");

-- CreateIndex
CREATE INDEX "NotificationWebhook_userId_idx" ON "NotificationWebhook"("userId");

-- CreateIndex
CREATE INDEX "NotificationWebhook_isActive_idx" ON "NotificationWebhook"("isActive");

-- CreateIndex
CREATE INDEX "NotificationWebhook_workspaceId_idx" ON "NotificationWebhook"("workspaceId");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_email_key" ON "UserProfile"("email");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_idx" ON "ConsentRecord"("userId");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_kind_idx" ON "ConsentRecord"("userId", "kind");

-- CreateIndex
CREATE INDEX "ConsentRecord_createdAt_idx" ON "ConsentRecord"("createdAt");

-- CreateIndex
CREATE INDEX "DataRetentionPolicy_workspaceId_idx" ON "DataRetentionPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "DataExportRequest_userId_idx" ON "DataExportRequest"("userId");

-- CreateIndex
CREATE INDEX "DataExportRequest_userId_status_idx" ON "DataExportRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "DataExportRequest_createdAt_idx" ON "DataExportRequest"("createdAt");

-- CreateIndex
CREATE INDEX "DataExportRequest_workspaceId_idx" ON "DataExportRequest"("workspaceId");

-- CreateIndex
CREATE INDEX "TwoFactorRecoveryCode_userId_idx" ON "TwoFactorRecoveryCode"("userId");

-- CreateIndex
CREATE INDEX "TwoFactorRecoveryCode_userId_usedAt_idx" ON "TwoFactorRecoveryCode"("userId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_sessionTokenHash_key" ON "UserSession"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "LoginEvent_userId_idx" ON "LoginEvent"("userId");

-- CreateIndex
CREATE INDEX "LoginEvent_createdAt_idx" ON "LoginEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE INDEX "Role_isSystem_idx" ON "Role"("isSystem");

-- CreateIndex
CREATE INDEX "Role_workspaceId_idx" ON "Role"("workspaceId");

-- CreateIndex
CREATE INDEX "UserRole_userId_idx" ON "UserRole"("userId");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE INDEX "CommandReceipt_workspaceId_expiresAt_idx" ON "CommandReceipt"("workspaceId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommandReceipt_workspaceId_scope_keyHash_key" ON "CommandReceipt"("workspaceId", "scope", "keyHash");

-- CreateIndex
CREATE INDEX "WebhookEvent_isProcessed_idx" ON "WebhookEvent"("isProcessed");

-- CreateIndex
CREATE INDEX "WebhookEvent_channel_idx" ON "WebhookEvent"("channel");

-- CreateIndex
CREATE INDEX "WebhookEvent_channel_externalId_idx" ON "WebhookEvent"("channel", "externalId");

-- CreateIndex
CREATE INDEX "WebhookEvent_channel_providerTimestamp_idx" ON "WebhookEvent"("channel", "providerTimestamp");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_nextAttemptAt_idx" ON "WebhookEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_connectionId_idx" ON "WebhookEvent"("connectionId");

-- CreateIndex
CREATE INDEX "WebhookEvent_workspaceId_idx" ON "WebhookEvent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_channel_externalId_key" ON "WebhookEvent"("workspaceId", "channel", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayNoticeQuarantine_resolvedReceiptId_key" ON "EbayNoticeQuarantine"("resolvedReceiptId");

-- CreateIndex
CREATE INDEX "EbayNoticeQuarantine_subjectHash_receivedAt_idx" ON "EbayNoticeQuarantine"("subjectHash", "receivedAt");

-- CreateIndex
CREATE INDEX "EbayNoticeQuarantine_firstOwnerWorkspaceId_resolvedAt_idx" ON "EbayNoticeQuarantine"("firstOwnerWorkspaceId", "resolvedAt");

-- CreateIndex
CREATE INDEX "EbayNoticeQuarantine_topic_reviewedAt_reviewNextAt_idx" ON "EbayNoticeQuarantine"("topic", "reviewedAt", "reviewNextAt");

-- CreateIndex
CREATE UNIQUE INDEX "EbayNoticeQuarantine_environment_signatureOk_externalId_key" ON "EbayNoticeQuarantine"("environment", "signatureOk", "externalId");

-- CreateIndex
CREATE INDEX "ErasureRequest_workspaceId_status_createdAt_idx" ON "ErasureRequest"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ErasureRequest_evidenceOrderId_idx" ON "ErasureRequest"("evidenceOrderId");

-- CreateIndex
CREATE INDEX "ErasureRequest_quarantineId_status_idx" ON "ErasureRequest"("quarantineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErasureRequest_workspace_quarantine_key" ON "ErasureRequest"("workspaceId", "quarantineId");

-- CreateIndex
CREATE INDEX "EbayQuarantineMaintenanceAudit_quarantineId_recordedAt_idx" ON "EbayQuarantineMaintenanceAudit"("quarantineId", "recordedAt");

-- CreateIndex
CREATE INDEX "ChannelLiveImage_productId_channel_idx" ON "ChannelLiveImage"("productId", "channel");

-- CreateIndex
CREATE INDEX "ChannelLiveImage_fetchedAt_idx" ON "ChannelLiveImage"("fetchedAt");

-- CreateIndex
CREATE INDEX "ChannelLiveImage_workspaceId_idx" ON "ChannelLiveImage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLiveImage_productId_channel_marketplace_extern_e9f2711dd" ON "ChannelLiveImage"("workspaceId", "productId", "channel", "marketplace", "externalSku", "slot");

-- CreateIndex
CREATE INDEX "ChannelStockEvent_status_idx" ON "ChannelStockEvent"("status");

-- CreateIndex
CREATE INDEX "ChannelStockEvent_channel_idx" ON "ChannelStockEvent"("channel");

-- CreateIndex
CREATE INDEX "ChannelStockEvent_productId_idx" ON "ChannelStockEvent"("productId");

-- CreateIndex
CREATE INDEX "ChannelStockEvent_sku_idx" ON "ChannelStockEvent"("sku");

-- CreateIndex
CREATE INDEX "ChannelStockEvent_createdAt_idx" ON "ChannelStockEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ChannelStockEvent_status_channel_createdAt_idx" ON "ChannelStockEvent"("status", "channel", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ChannelStockEvent_workspaceId_idx" ON "ChannelStockEvent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelStockEvent_channel_channelEventId_key" ON "ChannelStockEvent"("workspaceId", "channel", "channelEventId");

-- CreateIndex
CREATE INDEX "RateLimitLog_channel_idx" ON "RateLimitLog"("channel");

-- CreateIndex
CREATE INDEX "RateLimitLog_resetAt_idx" ON "RateLimitLog"("resetAt");

-- CreateIndex
CREATE INDEX "RateLimitLog_workspaceId_idx" ON "RateLimitLog"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitLog_channel_endpoint_resetAt_key" ON "RateLimitLog"("workspaceId", "channel", "endpoint", "resetAt");

-- CreateIndex
CREATE INDEX "SyncLog_productId_idx" ON "SyncLog"("productId");

-- CreateIndex
CREATE INDEX "SyncLog_status_idx" ON "SyncLog"("status");

-- CreateIndex
CREATE INDEX "SyncLog_syncType_idx" ON "SyncLog"("syncType");

-- CreateIndex
CREATE INDEX "SyncLog_workspaceId_idx" ON "SyncLog"("workspaceId");

-- CreateIndex
CREATE INDEX "SyncError_channel_idx" ON "SyncError"("channel");

-- CreateIndex
CREATE INDEX "SyncError_errorType_idx" ON "SyncError"("errorType");

-- CreateIndex
CREATE INDEX "SyncError_nextRetryAt_idx" ON "SyncError"("nextRetryAt");

-- CreateIndex
CREATE INDEX "SyncError_resolvedAt_idx" ON "SyncError"("resolvedAt");

-- CreateIndex
CREATE INDEX "SyncError_workspaceId_idx" ON "SyncError"("workspaceId");

-- CreateIndex
CREATE INDEX "Order_channelConnectionId_idx" ON "Order"("channelConnectionId");

-- CreateIndex
CREATE INDEX "Order_channel_idx" ON "Order"("channel");

-- CreateIndex
CREATE INDEX "Order_marketplace_idx" ON "Order"("marketplace");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_customerEmail_idx" ON "Order"("customerEmail");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_purchaseDate_idx" ON "Order"("purchaseDate");

-- CreateIndex
CREATE INDEX "Order_deliveredAt_idx" ON "Order"("deliveredAt");

-- CreateIndex
CREATE INDEX "Order_shipByDate_idx" ON "Order"("shipByDate");

-- CreateIndex
CREATE INDEX "Order_status_shipByDate_idx" ON "Order"("status", "shipByDate");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE INDEX "Order_fiscalKind_idx" ON "Order"("fiscalKind");

-- CreateIndex
CREATE INDEX "Order_status_deletedAt_idx" ON "Order"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "Order_workspaceId_idx" ON "Order"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_channel_channelOrderId_key" ON "Order"("workspaceId", "channel", "channelOrderId");

-- CreateIndex
CREATE INDEX "Customer_lastOrderAt_idx" ON "Customer"("lastOrderAt");

-- CreateIndex
CREATE INDEX "Customer_totalSpentCents_idx" ON "Customer"("totalSpentCents");

-- CreateIndex
CREATE INDEX "Customer_riskFlag_idx" ON "Customer"("riskFlag");

-- CreateIndex
CREATE INDEX "Customer_fiscalKind_idx" ON "Customer"("fiscalKind");

-- CreateIndex
CREATE INDEX "Customer_rfmLabel_idx" ON "Customer"("rfmLabel");

-- CreateIndex
CREATE INDEX "Customer_workspaceId_idx" ON "Customer"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_workspace_email_key" ON "Customer"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "CustomerSegment_createdAt_idx" ON "CustomerSegment"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "CustomerSegment_workspaceId_idx" ON "CustomerSegment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSegment_workspace_name_key" ON "CustomerSegment"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "CustomerAddress_customerId_idx" ON "CustomerAddress"("customerId");

-- CreateIndex
CREATE INDEX "CustomerAddress_country_idx" ON "CustomerAddress"("country");

-- CreateIndex
CREATE INDEX "CustomerAddress_workspaceId_idx" ON "CustomerAddress"("workspaceId");

-- CreateIndex
CREATE INDEX "CustomerNote_customerId_idx" ON "CustomerNote"("customerId");

-- CreateIndex
CREATE INDEX "CustomerNote_createdAt_idx" ON "CustomerNote"("createdAt");

-- CreateIndex
CREATE INDEX "CustomerNote_workspaceId_idx" ON "CustomerNote"("workspaceId");

-- CreateIndex
CREATE INDEX "FiscalInvoiceCounter_workspaceId_idx" ON "FiscalInvoiceCounter"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalInvoice_orderId_key" ON "FiscalInvoice"("orderId");

-- CreateIndex
CREATE INDEX "FiscalInvoice_invoiceNumber_idx" ON "FiscalInvoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "FiscalInvoice_issuedAt_idx" ON "FiscalInvoice"("issuedAt");

-- CreateIndex
CREATE INDEX "FiscalInvoice_sdiStatus_idx" ON "FiscalInvoice"("sdiStatus");

-- CreateIndex
CREATE INDEX "FiscalInvoice_workspaceId_idx" ON "FiscalInvoice"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalInvoice_issuer_fiscalYear_sequenceNumber_key" ON "FiscalInvoice"("workspaceId", "issuer", "fiscalYear", "sequenceNumber");

-- CreateIndex
CREATE INDEX "CreditNoteCounter_workspaceId_idx" ON "CreditNoteCounter"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_refundId_key" ON "CreditNote"("refundId");

-- CreateIndex
CREATE INDEX "CreditNote_refundId_idx" ON "CreditNote"("refundId");

-- CreateIndex
CREATE INDEX "CreditNote_creditNoteNumber_idx" ON "CreditNote"("creditNoteNumber");

-- CreateIndex
CREATE INDEX "CreditNote_issuedAt_idx" ON "CreditNote"("issuedAt");

-- CreateIndex
CREATE INDEX "CreditNote_sdiStatus_idx" ON "CreditNote"("sdiStatus");

-- CreateIndex
CREATE INDEX "CreditNote_originalInvoiceId_idx" ON "CreditNote"("originalInvoiceId");

-- CreateIndex
CREATE INDEX "CreditNote_workspaceId_idx" ON "CreditNote"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_issuer_fiscalYear_sequenceNumber_key" ON "CreditNote"("workspaceId", "issuer", "fiscalYear", "sequenceNumber");

-- CreateIndex
CREATE INDEX "OrderNote_orderId_idx" ON "OrderNote"("orderId");

-- CreateIndex
CREATE INDEX "OrderNote_createdAt_idx" ON "OrderNote"("createdAt");

-- CreateIndex
CREATE INDEX "OrderNote_workspaceId_idx" ON "OrderNote"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRiskScore_orderId_key" ON "OrderRiskScore"("orderId");

-- CreateIndex
CREATE INDEX "OrderRiskScore_flag_idx" ON "OrderRiskScore"("flag");

-- CreateIndex
CREATE INDEX "OrderRiskScore_score_idx" ON "OrderRiskScore"("score");

-- CreateIndex
CREATE INDEX "OrderRiskScore_computedAt_idx" ON "OrderRiskScore"("computedAt");

-- CreateIndex
CREATE INDEX "OrderRiskScore_workspaceId_idx" ON "OrderRiskScore"("workspaceId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "OrderItem_sku_idx" ON "OrderItem"("sku");

-- CreateIndex
CREATE INDEX "OrderItem_externalLineItemId_idx" ON "OrderItem"("externalLineItemId");

-- CreateIndex
CREATE INDEX "OrderItem_workspaceId_idx" ON "OrderItem"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_externalLineItemId_key" ON "OrderItem"("workspaceId", "orderId", "externalLineItemId");

-- CreateIndex
CREATE INDEX "DailySalesAggregate_sku_day_idx" ON "DailySalesAggregate"("sku", "day");

-- CreateIndex
CREATE INDEX "DailySalesAggregate_channel_marketplace_day_idx" ON "DailySalesAggregate"("channel", "marketplace", "day");

-- CreateIndex
CREATE INDEX "DailySalesAggregate_day_idx" ON "DailySalesAggregate"("day");

-- CreateIndex
CREATE INDEX "DailySalesAggregate_workspaceId_idx" ON "DailySalesAggregate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DailySalesAggregate_sku_channel_marketplace_day_key" ON "DailySalesAggregate"("workspaceId", "sku", "channel", "marketplace", "day");

-- CreateIndex
CREATE INDEX "ReplenishmentForecast_sku_horizonDay_idx" ON "ReplenishmentForecast"("sku", "horizonDay");

-- CreateIndex
CREATE INDEX "ReplenishmentForecast_channel_marketplace_horizonDay_idx" ON "ReplenishmentForecast"("channel", "marketplace", "horizonDay");

-- CreateIndex
CREATE INDEX "ReplenishmentForecast_horizonDay_idx" ON "ReplenishmentForecast"("horizonDay");

-- CreateIndex
CREATE INDEX "ReplenishmentForecast_workspaceId_idx" ON "ReplenishmentForecast"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentForecast_sku_channel_marketplace_horizon_5a855b66a" ON "ReplenishmentForecast"("workspaceId", "sku", "channel", "marketplace", "horizonDay", "model");

-- CreateIndex
CREATE INDEX "ForecastModelAssignment_modelId_idx" ON "ForecastModelAssignment"("modelId");

-- CreateIndex
CREATE INDEX "ForecastModelAssignment_cohort_idx" ON "ForecastModelAssignment"("cohort");

-- CreateIndex
CREATE INDEX "ForecastModelAssignment_sku_idx" ON "ForecastModelAssignment"("sku");

-- CreateIndex
CREATE INDEX "ForecastModelAssignment_workspaceId_idx" ON "ForecastModelAssignment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastModelAssignment_sku_modelId_key" ON "ForecastModelAssignment"("workspaceId", "sku", "modelId");

-- CreateIndex
CREATE INDEX "ForecastAccuracy_day_idx" ON "ForecastAccuracy"("day");

-- CreateIndex
CREATE INDEX "ForecastAccuracy_modelRegime_idx" ON "ForecastAccuracy"("modelRegime");

-- CreateIndex
CREATE INDEX "ForecastAccuracy_sku_day_idx" ON "ForecastAccuracy"("sku", "day");

-- CreateIndex
CREATE INDEX "ForecastAccuracy_workspaceId_idx" ON "ForecastAccuracy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastAccuracy_sku_channel_marketplace_day_key" ON "ForecastAccuracy"("workspaceId", "sku", "channel", "marketplace", "day");

-- CreateIndex
CREATE INDEX "BrandSettings_workspaceId_idx" ON "BrandSettings"("workspaceId");

-- CreateIndex
CREATE INDEX "RetailEvent_startDate_endDate_idx" ON "RetailEvent"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "RetailEvent_channel_marketplace_idx" ON "RetailEvent"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "RetailEvent_isActive_idx" ON "RetailEvent"("isActive");

-- CreateIndex
CREATE INDEX "RetailEvent_workspaceId_idx" ON "RetailEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "PricingSnapshot_sku_idx" ON "PricingSnapshot"("sku");

-- CreateIndex
CREATE INDEX "PricingSnapshot_channel_marketplace_idx" ON "PricingSnapshot"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "PricingSnapshot_source_idx" ON "PricingSnapshot"("source");

-- CreateIndex
CREATE INDEX "PricingSnapshot_computedAt_idx" ON "PricingSnapshot"("computedAt");

-- CreateIndex
CREATE INDEX "PricingSnapshot_workspaceId_idx" ON "PricingSnapshot"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingSnapshot_sku_channel_marketplace_fulfillmentMethod_key" ON "PricingSnapshot"("workspaceId", "sku", "channel", "marketplace", "fulfillmentMethod");

-- CreateIndex
CREATE INDEX "PriceChangeEvent_productId_channel_marketplace_changedAt_idx" ON "PriceChangeEvent"("productId", "channel", "marketplace", "changedAt");

-- CreateIndex
CREATE INDEX "PriceChangeEvent_sku_changedAt_idx" ON "PriceChangeEvent"("sku", "changedAt");

-- CreateIndex
CREATE INDEX "PriceChangeEvent_changedAt_idx" ON "PriceChangeEvent"("changedAt");

-- CreateIndex
CREATE INDEX "PriceChangeEvent_workspaceId_idx" ON "PriceChangeEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "BuyBoxHistory_productId_observedAt_idx" ON "BuyBoxHistory"("productId", "observedAt");

-- CreateIndex
CREATE INDEX "BuyBoxHistory_channel_marketplace_observedAt_idx" ON "BuyBoxHistory"("channel", "marketplace", "observedAt");

-- CreateIndex
CREATE INDEX "BuyBoxHistory_isOurOffer_observedAt_idx" ON "BuyBoxHistory"("isOurOffer", "observedAt");

-- CreateIndex
CREATE INDEX "BuyBoxHistory_workspaceId_idx" ON "BuyBoxHistory"("workspaceId");

-- CreateIndex
CREATE INDEX "FxRate_asOf_idx" ON "FxRate"("asOf");

-- CreateIndex
CREATE INDEX "FxRate_workspaceId_idx" ON "FxRate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_fromCurrency_toCurrency_asOf_key" ON "FxRate"("workspaceId", "fromCurrency", "toCurrency", "asOf");

-- CreateIndex
CREATE INDEX "RetailEventPriceAction_eventId_idx" ON "RetailEventPriceAction"("eventId");

-- CreateIndex
CREATE INDEX "RetailEventPriceAction_isActive_idx" ON "RetailEventPriceAction"("isActive");

-- CreateIndex
CREATE INDEX "RetailEventPriceAction_workspaceId_idx" ON "RetailEventPriceAction"("workspaceId");

-- CreateIndex
CREATE INDEX "SettlementReport_marketplaceId_startDate_idx" ON "SettlementReport"("marketplaceId", "startDate");

-- CreateIndex
CREATE INDEX "SettlementReport_depositDate_idx" ON "SettlementReport"("depositDate");

-- CreateIndex
CREATE INDEX "SettlementReport_workspaceId_idx" ON "SettlementReport"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReport_workspace_reportId_key" ON "SettlementReport"("workspaceId", "reportId");

-- CreateIndex
CREATE INDEX "FinancialTransaction_orderId_idx" ON "FinancialTransaction"("orderId");

-- CreateIndex
CREATE INDEX "FinancialTransaction_transactionType_idx" ON "FinancialTransaction"("transactionType");

-- CreateIndex
CREATE INDEX "FinancialTransaction_transactionDate_idx" ON "FinancialTransaction"("transactionDate");

-- CreateIndex
CREATE INDEX "FinancialTransaction_status_idx" ON "FinancialTransaction"("status");

-- CreateIndex
CREATE INDEX "FinancialTransaction_workspaceId_idx" ON "FinancialTransaction"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelConnection_workspaceId_channelType_idx" ON "ChannelConnection"("workspaceId", "channelType");

-- CreateIndex
CREATE INDEX "ChannelConnection_channelType_idx" ON "ChannelConnection"("channelType");

-- CreateIndex
CREATE INDEX "ChannelConnection_isActive_idx" ON "ChannelConnection"("isActive");

-- CreateIndex
CREATE INDEX "ChannelConnection_managedBy_idx" ON "ChannelConnection"("managedBy");

-- CreateIndex
CREATE INDEX "ChannelConnection_authStatus_idx" ON "ChannelConnection"("authStatus");

-- CreateIndex
CREATE INDEX "ChannelConnection_accessTokenExpiresAt_idx" ON "ChannelConnection"("accessTokenExpiresAt");

-- CreateIndex
CREATE INDEX "ChannelConnection_refreshTokenExpiresAt_idx" ON "ChannelConnection"("refreshTokenExpiresAt");

-- CreateIndex
CREATE INDEX "ConnectionScope_kind_externalId_idx" ON "ConnectionScope"("kind", "externalId");

-- CreateIndex
CREATE INDEX "ConnectionScope_workspaceId_idx" ON "ConnectionScope"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionScope_connectionId_kind_externalId_key" ON "ConnectionScope"("workspaceId", "connectionId", "kind", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelApp_channelKey_environment_key" ON "ChannelApp"("channelKey", "environment");

-- CreateIndex
CREATE INDEX "OAuthSession_workspaceId_idx" ON "OAuthSession"("workspaceId");

-- CreateIndex
CREATE INDEX "OAuthSession_expiresAt_idx" ON "OAuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "ConnectionEvent_connectionId_createdAt_idx" ON "ConnectionEvent"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "ConnectionEvent_type_createdAt_idx" ON "ConnectionEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ConnectionEvent_workspaceId_idx" ON "ConnectionEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_productId_idx" ON "OutboundSyncQueue"("productId");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_channelListingId_idx" ON "OutboundSyncQueue"("channelListingId");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_syncStatus_idx" ON "OutboundSyncQueue"("syncStatus");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_targetChannel_idx" ON "OutboundSyncQueue"("targetChannel");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_nextRetryAt_idx" ON "OutboundSyncQueue"("nextRetryAt");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_isDead_targetChannel_idx" ON "OutboundSyncQueue"("isDead", "targetChannel");

-- CreateIndex
CREATE INDEX "OutboundSyncQueue_workspaceId_idx" ON "OutboundSyncQueue"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkOperation_createdAt_idx" ON "BulkOperation"("createdAt");

-- CreateIndex
CREATE INDEX "BulkOperation_userId_idx" ON "BulkOperation"("userId");

-- CreateIndex
CREATE INDEX "BulkOperation_status_idx" ON "BulkOperation"("status");

-- CreateIndex
CREATE INDEX "BulkOperation_status_expiresAt_idx" ON "BulkOperation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BulkOperation_workspaceId_idx" ON "BulkOperation"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkOpsTemplate_userId_idx" ON "BulkOpsTemplate"("userId");

-- CreateIndex
CREATE INDEX "BulkOpsTemplate_updatedAt_idx" ON "BulkOpsTemplate"("updatedAt");

-- CreateIndex
CREATE INDEX "BulkOpsTemplate_workspaceId_idx" ON "BulkOpsTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkActionTemplate_userId_idx" ON "BulkActionTemplate"("userId");

-- CreateIndex
CREATE INDEX "BulkActionTemplate_category_idx" ON "BulkActionTemplate"("category");

-- CreateIndex
CREATE INDEX "BulkActionTemplate_actionType_idx" ON "BulkActionTemplate"("actionType");

-- CreateIndex
CREATE INDEX "BulkActionTemplate_usageCount_idx" ON "BulkActionTemplate"("usageCount" DESC);

-- CreateIndex
CREATE INDEX "BulkActionTemplate_workspaceId_idx" ON "BulkActionTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledBulkAction_enabled_nextRunAt_idx" ON "ScheduledBulkAction"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduledBulkAction_actionType_idx" ON "ScheduledBulkAction"("actionType");

-- CreateIndex
CREATE INDEX "ScheduledBulkAction_templateId_idx" ON "ScheduledBulkAction"("templateId");

-- CreateIndex
CREATE INDEX "ScheduledBulkAction_workspaceId_idx" ON "ScheduledBulkAction"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkAutomationApproval_status_expiresAt_idx" ON "BulkAutomationApproval"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BulkAutomationApproval_ruleId_createdAt_idx" ON "BulkAutomationApproval"("ruleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BulkAutomationApproval_workspaceId_idx" ON "BulkAutomationApproval"("workspaceId");

-- CreateIndex
CREATE INDEX "FlatFileImport_channel_createdAt_idx" ON "FlatFileImport"("channel", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "FlatFileImport_status_idx" ON "FlatFileImport"("status");

-- CreateIndex
CREATE INDEX "FlatFileImport_workspaceId_idx" ON "FlatFileImport"("workspaceId");

-- CreateIndex
CREATE INDEX "ImportJob_status_createdAt_idx" ON "ImportJob"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ImportJob_scheduleId_idx" ON "ImportJob"("scheduleId");

-- CreateIndex
CREATE INDEX "ImportJob_parentJobId_idx" ON "ImportJob"("parentJobId");

-- CreateIndex
CREATE INDEX "ImportJob_workspaceId_idx" ON "ImportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ImportJobRow_jobId_status_idx" ON "ImportJobRow"("jobId", "status");

-- CreateIndex
CREATE INDEX "ImportJobRow_targetId_idx" ON "ImportJobRow"("targetId");

-- CreateIndex
CREATE INDEX "ImportJobRow_workspaceId_idx" ON "ImportJobRow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportJobRow_jobId_rowIndex_key" ON "ImportJobRow"("workspaceId", "jobId", "rowIndex");

-- CreateIndex
CREATE INDEX "ScheduledImport_enabled_nextRunAt_idx" ON "ScheduledImport"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduledImport_workspaceId_idx" ON "ScheduledImport"("workspaceId");

-- CreateIndex
CREATE INDEX "ExportJob_status_createdAt_idx" ON "ExportJob"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ExportJob_scheduleId_idx" ON "ExportJob"("scheduleId");

-- CreateIndex
CREATE INDEX "ExportJob_workspaceId_idx" ON "ExportJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledExport_enabled_nextRunAt_idx" ON "ScheduledExport"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduledExport_workspaceId_idx" ON "ScheduledExport"("workspaceId");

-- CreateIndex
CREATE INDEX "MarketplaceTaxonomy_workspaceId_nextSyncAt_idx" ON "MarketplaceTaxonomy"("workspaceId", "nextSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceTaxonomy_workspaceId_channel_marketplace_key" ON "MarketplaceTaxonomy"("workspaceId", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "MarketplaceTaxonomySnapshot_workspaceId_sourceId_createdAt_idx" ON "MarketplaceTaxonomySnapshot"("workspaceId", "sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceTaxonomyNode_workspaceId_snapshotId_parentId_idx" ON "MarketplaceTaxonomyNode"("workspaceId", "snapshotId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceTaxonomyNode_workspaceId_snapshotId_externalId_key" ON "MarketplaceTaxonomyNode"("workspaceId", "snapshotId", "externalId");

-- CreateIndex
CREATE INDEX "CategorySchema_channel_marketplace_productType_idx" ON "CategorySchema"("channel", "marketplace", "productType");

-- CreateIndex
CREATE INDEX "CategorySchema_expiresAt_idx" ON "CategorySchema"("expiresAt");

-- CreateIndex
CREATE INDEX "CategorySchema_workspaceId_idx" ON "CategorySchema"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CategorySchema_channel_marketplace_productType_schema_26e10fef6" ON "CategorySchema"("workspaceId", "channel", "marketplace", "productType", "schemaVersion");

-- CreateIndex
CREATE INDEX "GtinExemptionApplication_status_idx" ON "GtinExemptionApplication"("status");

-- CreateIndex
CREATE INDEX "GtinExemptionApplication_brandName_idx" ON "GtinExemptionApplication"("brandName");

-- CreateIndex
CREATE INDEX "GtinExemptionApplication_brandName_marketplace_idx" ON "GtinExemptionApplication"("brandName", "marketplace");

-- CreateIndex
CREATE INDEX "GtinExemptionApplication_workspaceId_idx" ON "GtinExemptionApplication"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingWizard_productId_idx" ON "ListingWizard"("productId");

-- CreateIndex
CREATE INDEX "ListingWizard_status_idx" ON "ListingWizard"("status");

-- CreateIndex
CREATE INDEX "ListingWizard_expiresAt_idx" ON "ListingWizard"("expiresAt");

-- CreateIndex
CREATE INDEX "ListingWizard_workspaceId_idx" ON "ListingWizard"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingWizard_productId_channelsHash_status_key" ON "ListingWizard"("workspaceId", "productId", "channelsHash", "status");

-- CreateIndex
CREATE INDEX "ScheduledImagePublish_status_scheduledFor_idx" ON "ScheduledImagePublish"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ScheduledImagePublish_productId_idx" ON "ScheduledImagePublish"("productId");

-- CreateIndex
CREATE INDEX "ScheduledImagePublish_workspaceId_idx" ON "ScheduledImagePublish"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledWizardPublish_status_scheduledFor_idx" ON "ScheduledWizardPublish"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ScheduledWizardPublish_wizardId_idx" ON "ScheduledWizardPublish"("wizardId");

-- CreateIndex
CREATE INDEX "ScheduledWizardPublish_workspaceId_idx" ON "ScheduledWizardPublish"("workspaceId");

-- CreateIndex
CREATE INDEX "WizardStepEvent_wizardId_createdAt_idx" ON "WizardStepEvent"("wizardId", "createdAt");

-- CreateIndex
CREATE INDEX "WizardStepEvent_productId_createdAt_idx" ON "WizardStepEvent"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "WizardStepEvent_type_step_createdAt_idx" ON "WizardStepEvent"("type", "step", "createdAt");

-- CreateIndex
CREATE INDEX "WizardStepEvent_errorCode_createdAt_idx" ON "WizardStepEvent"("errorCode", "createdAt");

-- CreateIndex
CREATE INDEX "WizardStepEvent_createdAt_idx" ON "WizardStepEvent"("createdAt");

-- CreateIndex
CREATE INDEX "WizardStepEvent_workspaceId_idx" ON "WizardStepEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "WizardTemplate_builtIn_idx" ON "WizardTemplate"("builtIn");

-- CreateIndex
CREATE INDEX "WizardTemplate_usageCount_idx" ON "WizardTemplate"("usageCount");

-- CreateIndex
CREATE INDEX "WizardTemplate_lastUsedAt_idx" ON "WizardTemplate"("lastUsedAt");

-- CreateIndex
CREATE INDEX "WizardTemplate_workspaceId_idx" ON "WizardTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_idx" ON "AuditLog"("workspaceId");

-- CreateIndex
CREATE INDEX "APlusContent_marketplace_status_idx" ON "APlusContent"("marketplace", "status");

-- CreateIndex
CREATE INDEX "APlusContent_brand_idx" ON "APlusContent"("brand");

-- CreateIndex
CREATE INDEX "APlusContent_masterContentId_idx" ON "APlusContent"("masterContentId");

-- CreateIndex
CREATE INDEX "APlusContent_status_scheduledFor_idx" ON "APlusContent"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "APlusContent_workspaceId_idx" ON "APlusContent"("workspaceId");

-- CreateIndex
CREATE INDEX "APlusContentVersion_contentId_createdAt_idx" ON "APlusContentVersion"("contentId", "createdAt");

-- CreateIndex
CREATE INDEX "APlusContentVersion_workspaceId_idx" ON "APlusContentVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "APlusContentVersion_contentId_version_key" ON "APlusContentVersion"("workspaceId", "contentId", "version");

-- CreateIndex
CREATE INDEX "APlusContentAsin_asin_idx" ON "APlusContentAsin"("asin");

-- CreateIndex
CREATE INDEX "APlusContentAsin_productId_idx" ON "APlusContentAsin"("productId");

-- CreateIndex
CREATE INDEX "APlusContentAsin_workspaceId_idx" ON "APlusContentAsin"("workspaceId");

-- CreateIndex
CREATE INDEX "APlusModule_contentId_position_idx" ON "APlusModule"("contentId", "position");

-- CreateIndex
CREATE INDEX "APlusModule_workspaceId_idx" ON "APlusModule"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandStory_marketplace_status_idx" ON "BrandStory"("marketplace", "status");

-- CreateIndex
CREATE INDEX "BrandStory_brand_idx" ON "BrandStory"("brand");

-- CreateIndex
CREATE INDEX "BrandStory_masterStoryId_idx" ON "BrandStory"("masterStoryId");

-- CreateIndex
CREATE INDEX "BrandStory_status_scheduledFor_idx" ON "BrandStory"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "BrandStory_workspaceId_idx" ON "BrandStory"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandStory_brand_marketplace_locale_key" ON "BrandStory"("workspaceId", "brand", "marketplace", "locale");

-- CreateIndex
CREATE INDEX "BrandStoryModule_storyId_position_idx" ON "BrandStoryModule"("storyId", "position");

-- CreateIndex
CREATE INDEX "BrandStoryModule_workspaceId_idx" ON "BrandStoryModule"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandStoryVersion_storyId_createdAt_idx" ON "BrandStoryVersion"("storyId", "createdAt");

-- CreateIndex
CREATE INDEX "BrandStoryVersion_workspaceId_idx" ON "BrandStoryVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandStoryVersion_storyId_version_key" ON "BrandStoryVersion"("workspaceId", "storyId", "version");

-- CreateIndex
CREATE INDEX "BrandKit_workspaceId_idx" ON "BrandKit"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandKit_workspace_brand_key" ON "BrandKit"("workspaceId", "brand");

-- CreateIndex
CREATE INDEX "BrandWatermarkTemplate_brand_enabled_idx" ON "BrandWatermarkTemplate"("brand", "enabled");

-- CreateIndex
CREATE INDEX "BrandWatermarkTemplate_workspaceId_idx" ON "BrandWatermarkTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "AssetLocaleOverlay_locale_idx" ON "AssetLocaleOverlay"("locale");

-- CreateIndex
CREATE INDEX "AssetLocaleOverlay_workspaceId_idx" ON "AssetLocaleOverlay"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetLocaleOverlay_assetId_locale_key" ON "AssetLocaleOverlay"("workspaceId", "assetId", "locale");

-- CreateIndex
CREATE INDEX "ListingImage_productId_scope_platform_marketplace_idx" ON "ListingImage"("productId", "scope", "platform", "marketplace");

-- CreateIndex
CREATE INDEX "ListingImage_productId_variationId_scope_idx" ON "ListingImage"("productId", "variationId", "scope");

-- CreateIndex
CREATE INDEX "ListingImage_productId_position_idx" ON "ListingImage"("productId", "position");

-- CreateIndex
CREATE INDEX "ListingImage_productId_platform_amazonSlot_idx" ON "ListingImage"("productId", "platform", "amazonSlot");

-- CreateIndex
CREATE INDEX "ListingImage_productId_variantGroupKey_variantGroupValue_idx" ON "ListingImage"("productId", "variantGroupKey", "variantGroupValue");

-- CreateIndex
CREATE INDEX "ListingImage_productId_scope_platform_mediaType_idx" ON "ListingImage"("productId", "scope", "platform", "mediaType");

-- CreateIndex
CREATE INDEX "ListingImage_workspaceId_idx" ON "ListingImage"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonMediaRun_listingId_createdAt_idx" ON "AmazonMediaRun"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "AmazonMediaRun_status_updatedAt_idx" ON "AmazonMediaRun"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AmazonMediaRun_workspaceId_idx" ON "AmazonMediaRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonImageFeedJob_productId_marketplace_idx" ON "AmazonImageFeedJob"("productId", "marketplace");

-- CreateIndex
CREATE INDEX "AmazonImageFeedJob_feedId_idx" ON "AmazonImageFeedJob"("feedId");

-- CreateIndex
CREATE INDEX "AmazonImageFeedJob_status_submittedAt_idx" ON "AmazonImageFeedJob"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "AmazonImageFeedJob_workspaceId_idx" ON "AmazonImageFeedJob"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonFlatFileFeedJob_marketplace_productType_idx" ON "AmazonFlatFileFeedJob"("marketplace", "productType");

-- CreateIndex
CREATE INDEX "AmazonFlatFileFeedJob_status_submittedAt_idx" ON "AmazonFlatFileFeedJob"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "AmazonFlatFileFeedJob_nextPollAt_idx" ON "AmazonFlatFileFeedJob"("nextPollAt");

-- CreateIndex
CREATE INDEX "AmazonFlatFileFeedJob_workspaceId_idx" ON "AmazonFlatFileFeedJob"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonFlatFileFeedJob_workspace_feedId_key" ON "AmazonFlatFileFeedJob"("workspaceId", "feedId");

-- CreateIndex
CREATE INDEX "EbayPushJob_status_submittedAt_idx" ON "EbayPushJob"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "EbayPushJob_workspaceId_idx" ON "EbayPushJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelImagePublishJob_productId_channel_idx" ON "ChannelImagePublishJob"("productId", "channel");

-- CreateIndex
CREATE INDEX "ChannelImagePublishJob_status_submittedAt_idx" ON "ChannelImagePublishJob"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "ChannelImagePublishJob_channel_status_idx" ON "ChannelImagePublishJob"("channel", "status");

-- CreateIndex
CREATE INDEX "ChannelImagePublishJob_workspaceId_idx" ON "ChannelImagePublishJob"("workspaceId");

-- CreateIndex
CREATE INDEX "SchemaChange_channel_marketplace_productType_idx" ON "SchemaChange"("channel", "marketplace", "productType");

-- CreateIndex
CREATE INDEX "SchemaChange_detectedAt_idx" ON "SchemaChange"("detectedAt");

-- CreateIndex
CREATE INDEX "SchemaChange_workspaceId_idx" ON "SchemaChange"("workspaceId");

-- CreateIndex
CREATE INDEX "Warehouse_kind_idx" ON "Warehouse"("kind");

-- CreateIndex
CREATE INDEX "Warehouse_defaultCarrierAccountId_idx" ON "Warehouse"("defaultCarrierAccountId");

-- CreateIndex
CREATE INDEX "Warehouse_workspaceId_idx" ON "Warehouse"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_workspace_code_key" ON "Warehouse"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_workspace_shared_from_key" ON "Warehouse"("workspaceId", "sharedFromLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_warehouseId_key" ON "StockLocation"("warehouseId");

-- CreateIndex
CREATE INDEX "StockLocation_type_idx" ON "StockLocation"("type");

-- CreateIndex
CREATE INDEX "StockLocation_isActive_idx" ON "StockLocation"("isActive");

-- CreateIndex
CREATE INDEX "StockLocation_externalChannel_externalLocationId_idx" ON "StockLocation"("externalChannel", "externalLocationId");

-- CreateIndex
CREATE INDEX "StockLocation_workspaceId_idx" ON "StockLocation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_workspace_code_key" ON "StockLocation"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "StockLevel_productId_idx" ON "StockLevel"("productId");

-- CreateIndex
CREATE INDEX "StockLevel_locationId_idx" ON "StockLevel"("locationId");

-- CreateIndex
CREATE INDEX "StockLevel_quantity_idx" ON "StockLevel"("quantity");

-- CreateIndex
CREATE INDEX "StockLevel_syncStatus_idx" ON "StockLevel"("syncStatus");

-- CreateIndex
CREATE INDEX "StockLevel_workspaceId_idx" ON "StockLevel"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_locationId_productId_variationId_key" ON "StockLevel"("workspaceId", "locationId", "productId", "variationId");

-- CreateIndex
CREATE INDEX "StockReservation_stockLevelId_idx" ON "StockReservation"("stockLevelId");

-- CreateIndex
CREATE INDEX "StockReservation_orderId_idx" ON "StockReservation"("orderId");

-- CreateIndex
CREATE INDEX "StockReservation_expiresAt_idx" ON "StockReservation"("expiresAt");

-- CreateIndex
CREATE INDEX "StockReservation_releasedAt_consumedAt_idx" ON "StockReservation"("releasedAt", "consumedAt");

-- CreateIndex
CREATE INDEX "StockReservation_kind_idx" ON "StockReservation"("kind");

-- CreateIndex
CREATE INDEX "StockReservation_workspaceId_idx" ON "StockReservation"("workspaceId");

-- CreateIndex
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_variationId_createdAt_idx" ON "StockMovement"("variationId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_warehouseId_createdAt_idx" ON "StockMovement"("warehouseId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_locationId_createdAt_idx" ON "StockMovement"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_reason_idx" ON "StockMovement"("reason");

-- CreateIndex
CREATE INDEX "StockMovement_referenceType_referenceId_idx" ON "StockMovement"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "StockMovement_orderId_idx" ON "StockMovement"("orderId");

-- CreateIndex
CREATE INDEX "StockMovement_shipmentId_idx" ON "StockMovement"("shipmentId");

-- CreateIndex
CREATE INDEX "StockMovement_returnId_idx" ON "StockMovement"("returnId");

-- CreateIndex
CREATE INDEX "StockMovement_lotId_idx" ON "StockMovement"("lotId");

-- CreateIndex
CREATE INDEX "StockMovement_serialNumberId_idx" ON "StockMovement"("serialNumberId");

-- CreateIndex
CREATE INDEX "StockMovement_binId_idx" ON "StockMovement"("binId");

-- CreateIndex
CREATE INDEX "StockMovement_workspaceId_idx" ON "StockMovement"("workspaceId");

-- CreateIndex
CREATE INDEX "StockCostLayer_productId_receivedAt_idx" ON "StockCostLayer"("productId", "receivedAt");

-- CreateIndex
CREATE INDEX "StockCostLayer_productId_unitsRemaining_idx" ON "StockCostLayer"("productId", "unitsRemaining");

-- CreateIndex
CREATE INDEX "StockCostLayer_inboundShipmentId_idx" ON "StockCostLayer"("inboundShipmentId");

-- CreateIndex
CREATE INDEX "StockCostLayer_stockMovementId_idx" ON "StockCostLayer"("stockMovementId");

-- CreateIndex
CREATE INDEX "StockCostLayer_lotId_idx" ON "StockCostLayer"("lotId");

-- CreateIndex
CREATE INDEX "StockCostLayer_workspaceId_idx" ON "StockCostLayer"("workspaceId");

-- CreateIndex
CREATE INDEX "Lot_productId_receivedAt_idx" ON "Lot"("productId", "receivedAt");

-- CreateIndex
CREATE INDEX "Lot_expiresAt_idx" ON "Lot"("expiresAt");

-- CreateIndex
CREATE INDEX "Lot_productId_unitsRemaining_idx" ON "Lot"("productId", "unitsRemaining");

-- CreateIndex
CREATE INDEX "Lot_workspaceId_idx" ON "Lot"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_productId_lotNumber_key" ON "Lot"("workspaceId", "productId", "lotNumber");

-- CreateIndex
CREATE INDEX "SerialNumber_status_idx" ON "SerialNumber"("status");

-- CreateIndex
CREATE INDEX "SerialNumber_lotId_idx" ON "SerialNumber"("lotId");

-- CreateIndex
CREATE INDEX "SerialNumber_locationId_idx" ON "SerialNumber"("locationId");

-- CreateIndex
CREATE INDEX "SerialNumber_currentOrderId_idx" ON "SerialNumber"("currentOrderId");

-- CreateIndex
CREATE INDEX "SerialNumber_workspaceId_idx" ON "SerialNumber"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SerialNumber_productId_serialNumber_key" ON "SerialNumber"("workspaceId", "productId", "serialNumber");

-- CreateIndex
CREATE INDEX "StockBin_locationId_zone_idx" ON "StockBin"("locationId", "zone");

-- CreateIndex
CREATE INDEX "StockBin_workspaceId_idx" ON "StockBin"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBin_locationId_code_key" ON "StockBin"("workspaceId", "locationId", "code");

-- CreateIndex
CREATE INDEX "StockBinQuantity_binId_idx" ON "StockBinQuantity"("binId");

-- CreateIndex
CREATE INDEX "StockBinQuantity_workspaceId_idx" ON "StockBinQuantity"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBinQuantity_stockLevelId_binId_key" ON "StockBinQuantity"("workspaceId", "stockLevelId", "binId");

-- CreateIndex
CREATE INDEX "LotRecall_lotId_idx" ON "LotRecall"("lotId");

-- CreateIndex
CREATE INDEX "LotRecall_status_idx" ON "LotRecall"("status");

-- CreateIndex
CREATE INDEX "LotRecall_workspaceId_idx" ON "LotRecall"("workspaceId");

-- CreateIndex
CREATE INDEX "YearEndSnapshot_year_idx" ON "YearEndSnapshot"("year");

-- CreateIndex
CREATE INDEX "YearEndSnapshot_workspaceId_idx" ON "YearEndSnapshot"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "YearEndSnapshot_workspace_year_key" ON "YearEndSnapshot"("workspaceId", "year");

-- CreateIndex
CREATE INDEX "FbaInventoryDetail_productId_idx" ON "FbaInventoryDetail"("productId");

-- CreateIndex
CREATE INDEX "FbaInventoryDetail_marketplaceId_idx" ON "FbaInventoryDetail"("marketplaceId");

-- CreateIndex
CREATE INDEX "FbaInventoryDetail_fulfillmentCenterId_idx" ON "FbaInventoryDetail"("fulfillmentCenterId");

-- CreateIndex
CREATE INDEX "FbaInventoryDetail_condition_idx" ON "FbaInventoryDetail"("condition");

-- CreateIndex
CREATE INDEX "FbaInventoryDetail_firstReceivedAt_idx" ON "FbaInventoryDetail"("firstReceivedAt");

-- CreateIndex
CREATE INDEX "FbaInventoryDetail_workspaceId_idx" ON "FbaInventoryDetail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaInventoryDetail_sku_marketplaceId_fulfillmentCente_3d61041a5" ON "FbaInventoryDetail"("workspaceId", "sku", "marketplaceId", "fulfillmentCenterId", "condition");

-- CreateIndex
CREATE INDEX "MCFShipment_orderId_idx" ON "MCFShipment"("orderId");

-- CreateIndex
CREATE INDEX "MCFShipment_status_idx" ON "MCFShipment"("status");

-- CreateIndex
CREATE INDEX "MCFShipment_requestedAt_idx" ON "MCFShipment"("requestedAt");

-- CreateIndex
CREATE INDEX "MCFShipment_workspaceId_idx" ON "MCFShipment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MCFShipment_workspace_amazonFulfillmentOrderId_key" ON "MCFShipment"("workspaceId", "amazonFulfillmentOrderId");

-- CreateIndex
CREATE INDEX "Carrier_isActive_idx" ON "Carrier"("isActive");

-- CreateIndex
CREATE INDEX "Carrier_lastUsedAt_idx" ON "Carrier"("lastUsedAt");

-- CreateIndex
CREATE INDEX "Carrier_workspaceId_idx" ON "Carrier"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Carrier_workspace_code_key" ON "Carrier"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "CarrierService_carrierId_isActive_idx" ON "CarrierService"("carrierId", "isActive");

-- CreateIndex
CREATE INDEX "CarrierService_tier_idx" ON "CarrierService"("tier");

-- CreateIndex
CREATE INDEX "CarrierService_workspaceId_idx" ON "CarrierService"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierService_carrierId_externalId_key" ON "CarrierService"("workspaceId", "carrierId", "externalId");

-- CreateIndex
CREATE INDEX "CarrierServiceMapping_carrierId_idx" ON "CarrierServiceMapping"("carrierId");

-- CreateIndex
CREATE INDEX "CarrierServiceMapping_channel_marketplace_idx" ON "CarrierServiceMapping"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "CarrierServiceMapping_warehouseId_idx" ON "CarrierServiceMapping"("warehouseId");

-- CreateIndex
CREATE INDEX "CarrierServiceMapping_workspaceId_idx" ON "CarrierServiceMapping"("workspaceId");

-- CreateIndex
CREATE INDEX "CarrierMetric_carrierId_idx" ON "CarrierMetric"("carrierId");

-- CreateIndex
CREATE INDEX "CarrierMetric_workspaceId_idx" ON "CarrierMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierMetric_carrierId_windowDays_key" ON "CarrierMetric"("workspaceId", "carrierId", "windowDays");

-- CreateIndex
CREATE INDEX "PickupSchedule_carrierId_status_idx" ON "PickupSchedule"("carrierId", "status");

-- CreateIndex
CREATE INDEX "PickupSchedule_warehouseId_idx" ON "PickupSchedule"("warehouseId");

-- CreateIndex
CREATE INDEX "PickupSchedule_workspaceId_idx" ON "PickupSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "CarrierAccount_carrierId_isActive_idx" ON "CarrierAccount"("carrierId", "isActive");

-- CreateIndex
CREATE INDEX "CarrierAccount_workspaceId_idx" ON "CarrierAccount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierAccount_carrierId_accountLabel_key" ON "CarrierAccount"("workspaceId", "carrierId", "accountLabel");

-- CreateIndex
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");

-- CreateIndex
CREATE INDEX "Shipment_status_idx" ON "Shipment"("status");

-- CreateIndex
CREATE INDEX "Shipment_carrierCode_idx" ON "Shipment"("carrierCode");

-- CreateIndex
CREATE INDEX "Shipment_trackingNumber_idx" ON "Shipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "Shipment_createdAt_idx" ON "Shipment"("createdAt");

-- CreateIndex
CREATE INDEX "Shipment_status_deletedAt_idx" ON "Shipment"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "Shipment_workspaceId_idx" ON "Shipment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_workspace_sendcloudParcelId_key" ON "Shipment"("workspaceId", "sendcloudParcelId");

-- CreateIndex
CREATE INDEX "TrackingEvent_shipmentId_occurredAt_idx" ON "TrackingEvent"("shipmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "TrackingEvent_code_occurredAt_idx" ON "TrackingEvent"("code", "occurredAt");

-- CreateIndex
CREATE INDEX "TrackingEvent_occurredAt_idx" ON "TrackingEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "TrackingEvent_workspaceId_idx" ON "TrackingEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "TrackingMessageLog_status_nextAttemptAt_idx" ON "TrackingMessageLog"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TrackingMessageLog_shipmentId_channel_idx" ON "TrackingMessageLog"("shipmentId", "channel");

-- CreateIndex
CREATE INDEX "TrackingMessageLog_status_createdAt_idx" ON "TrackingMessageLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TrackingMessageLog_workspaceId_idx" ON "TrackingMessageLog"("workspaceId");

-- CreateIndex
CREATE INDEX "ShipmentItem_shipmentId_idx" ON "ShipmentItem"("shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentItem_productId_idx" ON "ShipmentItem"("productId");

-- CreateIndex
CREATE INDEX "ShipmentItem_workspaceId_idx" ON "ShipmentItem"("workspaceId");

-- CreateIndex
CREATE INDEX "ShippingRule_isActive_priority_idx" ON "ShippingRule"("isActive", "priority");

-- CreateIndex
CREATE INDEX "ShippingRule_lastFiredAt_idx" ON "ShippingRule"("lastFiredAt");

-- CreateIndex
CREATE INDEX "ShippingRule_workspaceId_idx" ON "ShippingRule"("workspaceId");

-- CreateIndex
CREATE INDEX "Supplier_workspaceId_idx" ON "Supplier"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierShippingProfile_supplierId_key" ON "SupplierShippingProfile"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierShippingProfile_supplierId_idx" ON "SupplierShippingProfile"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierShippingProfile_workspaceId_idx" ON "SupplierShippingProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierProduct_productId_idx" ON "SupplierProduct"("productId");

-- CreateIndex
CREATE INDEX "SupplierProduct_workspaceId_idx" ON "SupplierProduct"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_productId_key" ON "SupplierProduct"("workspaceId", "supplierId", "productId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_deletedAt_idx" ON "PurchaseOrder"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "PurchaseOrder_expectedDeliveryDate_deletedAt_idx" ON "PurchaseOrder"("expectedDeliveryDate", "deletedAt");

-- CreateIndex
CREATE INDEX "PurchaseOrder_workspaceId_idx" ON "PurchaseOrder"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_workspace_poNumber_key" ON "PurchaseOrder"("workspaceId", "poNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_workspace_supplierAckToken_key" ON "PurchaseOrder"("workspaceId", "supplierAckToken");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_workspace_approverAckToken_key" ON "PurchaseOrder"("workspaceId", "approverAckToken");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_productId_idx" ON "PurchaseOrderItem"("productId");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_lineOrder_idx" ON "PurchaseOrderItem"("purchaseOrderId", "lineOrder");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_workspaceId_idx" ON "PurchaseOrderItem"("workspaceId");

-- CreateIndex
CREATE INDEX "PurchaseOrderAttachment_purchaseOrderId_idx" ON "PurchaseOrderAttachment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderAttachment_kind_idx" ON "PurchaseOrderAttachment"("kind");

-- CreateIndex
CREATE INDEX "PurchaseOrderAttachment_workspaceId_idx" ON "PurchaseOrderAttachment"("workspaceId");

-- CreateIndex
CREATE INDEX "PurchaseOrderRevision_purchaseOrderId_idx" ON "PurchaseOrderRevision"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderRevision_status_idx" ON "PurchaseOrderRevision"("status");

-- CreateIndex
CREATE INDEX "PurchaseOrderRevision_workspaceId_idx" ON "PurchaseOrderRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderRevision_purchaseOrderId_version_key" ON "PurchaseOrderRevision"("workspaceId", "purchaseOrderId", "version");

-- CreateIndex
CREATE INDEX "PoComment_purchaseOrderId_createdAt_idx" ON "PoComment"("purchaseOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "PoComment_workspaceId_idx" ON "PoComment"("workspaceId");

-- CreateIndex
CREATE INDEX "PoEventLog_poId_createdAt_idx" ON "PoEventLog"("poId", "createdAt");

-- CreateIndex
CREATE INDEX "PoEventLog_type_createdAt_idx" ON "PoEventLog"("type", "createdAt");

-- CreateIndex
CREATE INDEX "PoEventLog_createdAt_idx" ON "PoEventLog"("createdAt");

-- CreateIndex
CREATE INDEX "PoEventLog_workspaceId_idx" ON "PoEventLog"("workspaceId");

-- CreateIndex
CREATE INDEX "PoTemplate_supplierId_idx" ON "PoTemplate"("supplierId");

-- CreateIndex
CREATE INDEX "PoTemplate_deletedAt_idx" ON "PoTemplate"("deletedAt");

-- CreateIndex
CREATE INDEX "PoTemplate_createdAt_idx" ON "PoTemplate"("createdAt");

-- CreateIndex
CREATE INDEX "PoTemplate_workspaceId_idx" ON "PoTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "PoTemplateItem_templateId_lineOrder_idx" ON "PoTemplateItem"("templateId", "lineOrder");

-- CreateIndex
CREATE INDEX "PoTemplateItem_workspaceId_idx" ON "PoTemplateItem"("workspaceId");

-- CreateIndex
CREATE INDEX "PoSchedule_nextRunAt_isActive_idx" ON "PoSchedule"("nextRunAt", "isActive");

-- CreateIndex
CREATE INDEX "PoSchedule_templateId_idx" ON "PoSchedule"("templateId");

-- CreateIndex
CREATE INDEX "PoSchedule_workspaceId_idx" ON "PoSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundShipment_type_idx" ON "InboundShipment"("type");

-- CreateIndex
CREATE INDEX "InboundShipment_status_idx" ON "InboundShipment"("status");

-- CreateIndex
CREATE INDEX "InboundShipment_fbaShipmentId_idx" ON "InboundShipment"("fbaShipmentId");

-- CreateIndex
CREATE INDEX "InboundShipment_purchaseOrderId_idx" ON "InboundShipment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "InboundShipment_carrierCode_idx" ON "InboundShipment"("carrierCode");

-- CreateIndex
CREATE INDEX "InboundShipment_trackingNumber_idx" ON "InboundShipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "InboundShipment_expectedAt_idx" ON "InboundShipment"("expectedAt");

-- CreateIndex
CREATE INDEX "InboundShipment_status_deletedAt_idx" ON "InboundShipment"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "InboundShipment_workspaceId_idx" ON "InboundShipment"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundShipmentAttachment_inboundShipmentId_idx" ON "InboundShipmentAttachment"("inboundShipmentId");

-- CreateIndex
CREATE INDEX "InboundShipmentAttachment_kind_idx" ON "InboundShipmentAttachment"("kind");

-- CreateIndex
CREATE INDEX "InboundShipmentAttachment_workspaceId_idx" ON "InboundShipmentAttachment"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundDiscrepancy_inboundShipmentId_idx" ON "InboundDiscrepancy"("inboundShipmentId");

-- CreateIndex
CREATE INDEX "InboundDiscrepancy_inboundShipmentItemId_idx" ON "InboundDiscrepancy"("inboundShipmentItemId");

-- CreateIndex
CREATE INDEX "InboundDiscrepancy_status_idx" ON "InboundDiscrepancy"("status");

-- CreateIndex
CREATE INDEX "InboundDiscrepancy_reasonCode_idx" ON "InboundDiscrepancy"("reasonCode");

-- CreateIndex
CREATE INDEX "InboundDiscrepancy_workspaceId_idx" ON "InboundDiscrepancy"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundShipmentItem_inboundShipmentId_idx" ON "InboundShipmentItem"("inboundShipmentId");

-- CreateIndex
CREATE INDEX "InboundShipmentItem_productId_idx" ON "InboundShipmentItem"("productId");

-- CreateIndex
CREATE INDEX "InboundShipmentItem_purchaseOrderItemId_idx" ON "InboundShipmentItem"("purchaseOrderItemId");

-- CreateIndex
CREATE INDEX "InboundShipmentItem_lotNumber_idx" ON "InboundShipmentItem"("lotNumber");

-- CreateIndex
CREATE INDEX "InboundShipmentItem_workspaceId_idx" ON "InboundShipmentItem"("workspaceId");

-- CreateIndex
CREATE INDEX "InboundReceipt_inboundShipmentItemId_idx" ON "InboundReceipt"("inboundShipmentItemId");

-- CreateIndex
CREATE INDEX "InboundReceipt_receivedAt_idx" ON "InboundReceipt"("receivedAt");

-- CreateIndex
CREATE INDEX "InboundReceipt_idempotencyKey_idx" ON "InboundReceipt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InboundReceipt_workspaceId_idx" ON "InboundReceipt"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkOrder_productId_idx" ON "WorkOrder"("productId");

-- CreateIndex
CREATE INDEX "WorkOrder_status_idx" ON "WorkOrder"("status");

-- CreateIndex
CREATE INDEX "WorkOrder_workspaceId_idx" ON "WorkOrder"("workspaceId");

-- CreateIndex
CREATE INDEX "Return_orderId_idx" ON "Return"("orderId");

-- CreateIndex
CREATE INDEX "Return_status_idx" ON "Return"("status");

-- CreateIndex
CREATE INDEX "Return_channel_idx" ON "Return"("channel");

-- CreateIndex
CREATE INDEX "Return_isFbaReturn_idx" ON "Return"("isFbaReturn");

-- CreateIndex
CREATE INDEX "Return_returnTrackingNumber_idx" ON "Return"("returnTrackingNumber");

-- CreateIndex
CREATE INDEX "Return_sendcloudParcelId_idx" ON "Return"("sendcloudParcelId");

-- CreateIndex
CREATE INDEX "Return_workspaceId_idx" ON "Return"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Return_workspace_rmaNumber_key" ON "Return"("workspaceId", "rmaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Return_workspace_idempotencyKey_key" ON "Return"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ReturnItem_returnId_idx" ON "ReturnItem"("returnId");

-- CreateIndex
CREATE INDEX "ReturnItem_productId_idx" ON "ReturnItem"("productId");

-- CreateIndex
CREATE INDEX "ReturnItem_disposition_idx" ON "ReturnItem"("disposition");

-- CreateIndex
CREATE INDEX "ReturnItem_lotId_idx" ON "ReturnItem"("lotId");

-- CreateIndex
CREATE INDEX "ReturnItem_workspaceId_idx" ON "ReturnItem"("workspaceId");

-- CreateIndex
CREATE INDEX "Refund_returnId_idx" ON "Refund"("returnId");

-- CreateIndex
CREATE INDEX "Refund_channelRefundId_idx" ON "Refund"("channelRefundId");

-- CreateIndex
CREATE INDEX "Refund_channelStatus_idx" ON "Refund"("channelStatus");

-- CreateIndex
CREATE INDEX "Refund_channel_idx" ON "Refund"("channel");

-- CreateIndex
CREATE INDEX "Refund_workspaceId_idx" ON "Refund"("workspaceId");

-- CreateIndex
CREATE INDEX "RefundAttempt_refundId_idx" ON "RefundAttempt"("refundId");

-- CreateIndex
CREATE INDEX "RefundAttempt_attemptedAt_idx" ON "RefundAttempt"("attemptedAt");

-- CreateIndex
CREATE INDEX "RefundAttempt_workspaceId_idx" ON "RefundAttempt"("workspaceId");

-- CreateIndex
CREATE INDEX "ReturnPolicy_channel_idx" ON "ReturnPolicy"("channel");

-- CreateIndex
CREATE INDEX "ReturnPolicy_isActive_idx" ON "ReturnPolicy"("isActive");

-- CreateIndex
CREATE INDEX "ReturnPolicy_workspaceId_idx" ON "ReturnPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnPolicy_channel_marketplace_productType_key" ON "ReturnPolicy"("workspaceId", "channel", "marketplace", "productType");

-- CreateIndex
CREATE INDEX "ReplenishmentRule_preferredSupplierId_idx" ON "ReplenishmentRule"("preferredSupplierId");

-- CreateIndex
CREATE INDEX "ReplenishmentRule_workspaceId_idx" ON "ReplenishmentRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentRule_workspace_productId_key" ON "ReplenishmentRule"("workspaceId", "productId");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_productId_status_idx" ON "ReplenishmentRecommendation"("productId", "status");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_generatedAt_idx" ON "ReplenishmentRecommendation"("generatedAt");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_urgency_status_idx" ON "ReplenishmentRecommendation"("urgency", "status");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_resultingPoId_idx" ON "ReplenishmentRecommendation"("resultingPoId");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_workspaceId_idx" ON "ReplenishmentRecommendation"("workspaceId");

-- CreateIndex
CREATE INDEX "CycleCount_locationId_status_idx" ON "CycleCount"("locationId", "status");

-- CreateIndex
CREATE INDEX "CycleCount_status_idx" ON "CycleCount"("status");

-- CreateIndex
CREATE INDEX "CycleCount_createdAt_idx" ON "CycleCount"("createdAt");

-- CreateIndex
CREATE INDEX "CycleCount_workspaceId_idx" ON "CycleCount"("workspaceId");

-- CreateIndex
CREATE INDEX "CycleCountItem_cycleCountId_status_idx" ON "CycleCountItem"("cycleCountId", "status");

-- CreateIndex
CREATE INDEX "CycleCountItem_productId_idx" ON "CycleCountItem"("productId");

-- CreateIndex
CREATE INDEX "CycleCountItem_workspaceId_idx" ON "CycleCountItem"("workspaceId");

-- CreateIndex
CREATE INDEX "OrderRoutingRule_priority_isActive_idx" ON "OrderRoutingRule"("priority", "isActive");

-- CreateIndex
CREATE INDEX "OrderRoutingRule_warehouseId_idx" ON "OrderRoutingRule"("warehouseId");

-- CreateIndex
CREATE INDEX "OrderRoutingRule_workspaceId_idx" ON "OrderRoutingRule"("workspaceId");

-- CreateIndex
CREATE INDEX "ReplenishmentSavedView_isDefault_idx" ON "ReplenishmentSavedView"("isDefault");

-- CreateIndex
CREATE INDEX "ReplenishmentSavedView_createdAt_idx" ON "ReplenishmentSavedView"("createdAt");

-- CreateIndex
CREATE INDEX "ReplenishmentSavedView_workspaceId_idx" ON "ReplenishmentSavedView"("workspaceId");

-- CreateIndex
CREATE INDEX "CronRun_jobName_startedAt_idx" ON "CronRun"("jobName", "startedAt");

-- CreateIndex
CREATE INDEX "CronRun_status_idx" ON "CronRun"("status");

-- CreateIndex
CREATE INDEX "CronRun_startedAt_idx" ON "CronRun"("startedAt");

-- CreateIndex
CREATE INDEX "CronRun_workspaceId_idx" ON "CronRun"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_channel_createdAt_idx" ON "OutboundApiCallLog"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_createdAt_idx" ON "OutboundApiCallLog"("createdAt");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_success_createdAt_idx" ON "OutboundApiCallLog"("success", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_operation_createdAt_idx" ON "OutboundApiCallLog"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_statusCode_createdAt_idx" ON "OutboundApiCallLog"("statusCode", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_requestId_idx" ON "OutboundApiCallLog"("requestId");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_productId_idx" ON "OutboundApiCallLog"("productId");

-- CreateIndex
CREATE INDEX "OutboundApiCallLog_workspaceId_idx" ON "OutboundApiCallLog"("workspaceId");

-- CreateIndex
CREATE INDEX "SyncLogErrorGroup_channel_lastSeen_idx" ON "SyncLogErrorGroup"("channel", "lastSeen");

-- CreateIndex
CREATE INDEX "SyncLogErrorGroup_resolutionStatus_lastSeen_idx" ON "SyncLogErrorGroup"("resolutionStatus", "lastSeen");

-- CreateIndex
CREATE INDEX "SyncLogErrorGroup_lastSeen_idx" ON "SyncLogErrorGroup"("lastSeen");

-- CreateIndex
CREATE INDEX "SyncLogErrorGroup_workspaceId_idx" ON "SyncLogErrorGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncLogErrorGroup_workspace_fingerprint_key" ON "SyncLogErrorGroup"("workspaceId", "fingerprint");

-- CreateIndex
CREATE INDEX "SyncLogSavedSearch_surface_name_idx" ON "SyncLogSavedSearch"("surface", "name");

-- CreateIndex
CREATE INDEX "SyncLogSavedSearch_workspaceId_idx" ON "SyncLogSavedSearch"("workspaceId");

-- CreateIndex
CREATE INDEX "AlertRule_enabled_idx" ON "AlertRule"("enabled");

-- CreateIndex
CREATE INDEX "AlertRule_metric_idx" ON "AlertRule"("metric");

-- CreateIndex
CREATE INDEX "AlertRule_workspaceId_idx" ON "AlertRule"("workspaceId");

-- CreateIndex
CREATE INDEX "AlertEvent_ruleId_status_idx" ON "AlertEvent"("ruleId", "status");

-- CreateIndex
CREATE INDEX "AlertEvent_status_triggeredAt_idx" ON "AlertEvent"("status", "triggeredAt");

-- CreateIndex
CREATE INDEX "AlertEvent_triggeredAt_idx" ON "AlertEvent"("triggeredAt");

-- CreateIndex
CREATE INDEX "AlertEvent_workspaceId_idx" ON "AlertEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductSubstitution_substituteProductId_idx" ON "ProductSubstitution"("substituteProductId");

-- CreateIndex
CREATE INDEX "ProductSubstitution_workspaceId_idx" ON "ProductSubstitution"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSubstitution_primaryProductId_substituteProductId_key" ON "ProductSubstitution"("workspaceId", "primaryProductId", "substituteProductId");

-- CreateIndex
CREATE INDEX "StockoutEvent_productId_startedAt_idx" ON "StockoutEvent"("productId", "startedAt");

-- CreateIndex
CREATE INDEX "StockoutEvent_endedAt_idx" ON "StockoutEvent"("endedAt");

-- CreateIndex
CREATE INDEX "StockoutEvent_sku_startedAt_idx" ON "StockoutEvent"("sku", "startedAt");

-- CreateIndex
CREATE INDEX "StockoutEvent_workspaceId_idx" ON "StockoutEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "AutoPoRunLog_startedAt_idx" ON "AutoPoRunLog"("startedAt");

-- CreateIndex
CREATE INDEX "AutoPoRunLog_triggeredBy_idx" ON "AutoPoRunLog"("triggeredBy");

-- CreateIndex
CREATE INDEX "AutoPoRunLog_workspaceId_idx" ON "AutoPoRunLog"("workspaceId");

-- CreateIndex
CREATE INDEX "FbaRestockReport_marketplace_idx" ON "FbaRestockReport"("marketplace");

-- CreateIndex
CREATE INDEX "FbaRestockReport_status_idx" ON "FbaRestockReport"("status");

-- CreateIndex
CREATE INDEX "FbaRestockReport_requestedAt_idx" ON "FbaRestockReport"("requestedAt");

-- CreateIndex
CREATE INDEX "FbaRestockReport_workspaceId_idx" ON "FbaRestockReport"("workspaceId");

-- CreateIndex
CREATE INDEX "FbaRestockRow_sku_marketplace_asOf_idx" ON "FbaRestockRow"("sku", "marketplace", "asOf");

-- CreateIndex
CREATE INDEX "FbaRestockRow_reportId_idx" ON "FbaRestockRow"("reportId");

-- CreateIndex
CREATE INDEX "FbaRestockRow_workspaceId_idx" ON "FbaRestockRow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaRestockRow_sku_marketplace_reportId_key" ON "FbaRestockRow"("workspaceId", "sku", "marketplace", "reportId");

-- CreateIndex
CREATE INDEX "FbaInboundPlanV2_planId_idx" ON "FbaInboundPlanV2"("planId");

-- CreateIndex
CREATE INDEX "FbaInboundPlanV2_status_idx" ON "FbaInboundPlanV2"("status");

-- CreateIndex
CREATE INDEX "FbaInboundPlanV2_inboundShipmentId_idx" ON "FbaInboundPlanV2"("inboundShipmentId");

-- CreateIndex
CREATE INDEX "FbaInboundPlanV2_createdAt_idx" ON "FbaInboundPlanV2"("createdAt");

-- CreateIndex
CREATE INDEX "FbaInboundPlanV2_workspaceId_idx" ON "FbaInboundPlanV2"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaInboundPlanV2_workspace_planId_key" ON "FbaInboundPlanV2"("workspaceId", "planId");

-- CreateIndex
CREATE INDEX "Tag_workspaceId_idx" ON "Tag"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_workspace_name_key" ON "Tag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AssetTag_assetId_idx" ON "AssetTag"("assetId");

-- CreateIndex
CREATE INDEX "AssetTag_tagId_idx" ON "AssetTag"("tagId");

-- CreateIndex
CREATE INDEX "AssetTag_workspaceId_idx" ON "AssetTag"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductTag_productId_idx" ON "ProductTag"("productId");

-- CreateIndex
CREATE INDEX "ProductTag_tagId_idx" ON "ProductTag"("tagId");

-- CreateIndex
CREATE INDEX "ProductTag_workspaceId_idx" ON "ProductTag"("workspaceId");

-- CreateIndex
CREATE INDEX "Bundle_workspaceId_idx" ON "Bundle"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_workspace_productId_key" ON "Bundle"("workspaceId", "productId");

-- CreateIndex
CREATE INDEX "BundleComponent_bundleId_idx" ON "BundleComponent"("bundleId");

-- CreateIndex
CREATE INDEX "BundleComponent_productId_idx" ON "BundleComponent"("productId");

-- CreateIndex
CREATE INDEX "BundleComponent_workspaceId_idx" ON "BundleComponent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleComponent_bundleId_productId_key" ON "BundleComponent"("workspaceId", "bundleId", "productId");

-- CreateIndex
CREATE INDEX "SavedView_userId_surface_idx" ON "SavedView"("userId", "surface");

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_idx" ON "SavedView"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_userId_surface_name_key" ON "SavedView"("workspaceId", "userId", "surface", "name");

-- CreateIndex
CREATE INDEX "Review_productId_postedAt_idx" ON "Review"("productId", "postedAt");

-- CreateIndex
CREATE INDEX "Review_marketplace_postedAt_idx" ON "Review"("marketplace", "postedAt");

-- CreateIndex
CREATE INDEX "Review_postedAt_idx" ON "Review"("postedAt");

-- CreateIndex
CREATE INDEX "Review_attributedRequestId_idx" ON "Review"("attributedRequestId");

-- CreateIndex
CREATE INDEX "Review_attributedRuleId_idx" ON "Review"("attributedRuleId");

-- CreateIndex
CREATE INDEX "Review_channel_ingestedAt_idx" ON "Review"("channel", "ingestedAt");

-- CreateIndex
CREATE INDEX "Review_triageStatus_idx" ON "Review"("triageStatus");

-- CreateIndex
CREATE INDEX "Review_assignee_idx" ON "Review"("assignee");

-- CreateIndex
CREATE INDEX "Review_workspaceId_idx" ON "Review"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_channel_externalReviewId_key" ON "Review"("workspaceId", "channel", "externalReviewId");

-- CreateIndex
CREATE INDEX "ReviewResponse_reviewId_idx" ON "ReviewResponse"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewResponse_status_idx" ON "ReviewResponse"("status");

-- CreateIndex
CREATE INDEX "ReviewResponse_workspaceId_idx" ON "ReviewResponse"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewSpotlight_productId_generatedAt_idx" ON "ReviewSpotlight"("productId", "generatedAt");

-- CreateIndex
CREATE INDEX "ReviewSpotlight_generatedAt_idx" ON "ReviewSpotlight"("generatedAt");

-- CreateIndex
CREATE INDEX "ReviewSpotlight_workspaceId_idx" ON "ReviewSpotlight"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewActionItem_status_createdAt_idx" ON "ReviewActionItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewActionItem_spikeId_idx" ON "ReviewActionItem"("spikeId");

-- CreateIndex
CREATE INDEX "ReviewActionItem_productId_idx" ON "ReviewActionItem"("productId");

-- CreateIndex
CREATE INDEX "ReviewActionItem_workspaceId_idx" ON "ReviewActionItem"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSentiment_reviewId_key" ON "ReviewSentiment"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewSentiment_label_idx" ON "ReviewSentiment"("label");

-- CreateIndex
CREATE INDEX "ReviewSentiment_extractedAt_idx" ON "ReviewSentiment"("extractedAt");

-- CreateIndex
CREATE INDEX "ReviewSentiment_workspaceId_idx" ON "ReviewSentiment"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewCategoryRate_productId_marketplace_category_date_idx" ON "ReviewCategoryRate"("productId", "marketplace", "category", "date" DESC);

-- CreateIndex
CREATE INDEX "ReviewCategoryRate_workspaceId_idx" ON "ReviewCategoryRate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCategoryRate_productId_marketplace_category_date_key" ON "ReviewCategoryRate"("workspaceId", "productId", "marketplace", "category", "date");

-- CreateIndex
CREATE INDEX "ReviewSpike_productId_marketplace_category_detectedAt_idx" ON "ReviewSpike"("productId", "marketplace", "category", "detectedAt" DESC);

-- CreateIndex
CREATE INDEX "ReviewSpike_status_detectedAt_idx" ON "ReviewSpike"("status", "detectedAt" DESC);

-- CreateIndex
CREATE INDEX "ReviewSpike_workspaceId_idx" ON "ReviewSpike"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonReviewInsight_productId_idx" ON "AmazonReviewInsight"("productId");

-- CreateIndex
CREATE INDEX "AmazonReviewInsight_marketplace_fetchedAt_idx" ON "AmazonReviewInsight"("marketplace", "fetchedAt");

-- CreateIndex
CREATE INDEX "AmazonReviewInsight_accessStatus_idx" ON "AmazonReviewInsight"("accessStatus");

-- CreateIndex
CREATE INDEX "AmazonReviewInsight_workspaceId_idx" ON "AmazonReviewInsight"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonReviewInsight_asin_marketplace_key" ON "AmazonReviewInsight"("workspaceId", "asin", "marketplace");

-- CreateIndex
CREATE INDEX "ReviewRequest_status_idx" ON "ReviewRequest"("status");

-- CreateIndex
CREATE INDEX "ReviewRequest_scheduledFor_idx" ON "ReviewRequest"("scheduledFor");

-- CreateIndex
CREATE INDEX "ReviewRequest_sentAt_idx" ON "ReviewRequest"("sentAt");

-- CreateIndex
CREATE INDEX "ReviewRequest_workspaceId_idx" ON "ReviewRequest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRequest_orderId_channel_key" ON "ReviewRequest"("workspaceId", "orderId", "channel");

-- CreateIndex
CREATE INDEX "ReviewRule_scope_isActive_idx" ON "ReviewRule"("scope", "isActive");

-- CreateIndex
CREATE INDEX "ReviewRule_workspaceId_idx" ON "ReviewRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRule_name_scope_marketplace_key" ON "ReviewRule"("workspaceId", "name", "scope", "marketplace");

-- CreateIndex
CREATE INDEX "ReviewTimingDefault_isActive_sortOrder_idx" ON "ReviewTimingDefault"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "ReviewTimingDefault_workspaceId_idx" ON "ReviewTimingDefault"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTimingDefault_workspace_pattern_key" ON "ReviewTimingDefault"("workspaceId", "pattern");

-- CreateIndex
CREATE INDEX "ReviewSendWindow_marketplace_isActive_idx" ON "ReviewSendWindow"("marketplace", "isActive");

-- CreateIndex
CREATE INDEX "ReviewSendWindow_workspaceId_idx" ON "ReviewSendWindow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSendWindow_marketplace_dayOfWeek_key" ON "ReviewSendWindow"("workspaceId", "marketplace", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSentimentCheck_reviewRequestId_key" ON "ReviewSentimentCheck"("reviewRequestId");

-- CreateIndex
CREATE INDEX "ReviewSentimentCheck_orderId_idx" ON "ReviewSentimentCheck"("orderId");

-- CreateIndex
CREATE INDEX "ReviewSentimentCheck_response_sentimentEmailSentAt_idx" ON "ReviewSentimentCheck"("response", "sentimentEmailSentAt");

-- CreateIndex
CREATE INDEX "ReviewSentimentCheck_expiresAt_idx" ON "ReviewSentimentCheck"("expiresAt");

-- CreateIndex
CREATE INDEX "ReviewSentimentCheck_workspaceId_idx" ON "ReviewSentimentCheck"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSentimentCheck_workspace_token_key" ON "ReviewSentimentCheck"("workspaceId", "token");

-- CreateIndex
CREATE INDEX "ReviewMailerState_workspaceId_idx" ON "ReviewMailerState"("workspaceId");

-- CreateIndex
CREATE INDEX "EmailSuppression_email_idx" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "EmailSuppression_workspaceId_idx" ON "EmailSuppression"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_channel_key" ON "EmailSuppression"("workspaceId", "email", "channel");

-- CreateIndex
CREATE INDEX "OrderTag_orderId_idx" ON "OrderTag"("orderId");

-- CreateIndex
CREATE INDEX "OrderTag_tagId_idx" ON "OrderTag"("tagId");

-- CreateIndex
CREATE INDEX "OrderTag_workspaceId_idx" ON "OrderTag"("workspaceId");

-- CreateIndex
CREATE INDEX "AiUsageLog_provider_createdAt_idx" ON "AiUsageLog"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_feature_createdAt_idx" ON "AiUsageLog"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_entityType_entityId_idx" ON "AiUsageLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AiUsageLog_userId_createdAt_idx" ON "AiUsageLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_createdAt_idx" ON "AiUsageLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_workspaceId_idx" ON "AiUsageLog"("workspaceId");

-- CreateIndex
CREATE INDEX "AiFeatureModelPref_workspaceId_idx" ON "AiFeatureModelPref"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiFeatureModelPref_workspace_featureKey_key" ON "AiFeatureModelPref"("workspaceId", "featureKey");

-- CreateIndex
CREATE INDEX "ProductAiDraft_status_createdAt_idx" ON "ProductAiDraft"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProductAiDraft_productId_status_idx" ON "ProductAiDraft"("productId", "status");

-- CreateIndex
CREATE INDEX "ProductAiDraft_runId_idx" ON "ProductAiDraft"("runId");

-- CreateIndex
CREATE INDEX "ProductAiDraft_productId_channel_marketplace_status_idx" ON "ProductAiDraft"("productId", "channel", "marketplace", "status");

-- CreateIndex
CREATE INDEX "ProductAiDraft_workspaceId_idx" ON "ProductAiDraft"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAiDraft_cell_run_key" ON "ProductAiDraft"("workspaceId", "productId", "cellKey", "runId");

-- CreateIndex
CREATE INDEX "AgentDefinition_workspaceId_idx" ON "AgentDefinition"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_workspace_key_key" ON "AgentDefinition"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AgentRun_agentKey_createdAt_idx" ON "AgentRun"("agentKey", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_status_createdAt_idx" ON "AgentRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_entityType_entityId_idx" ON "AgentRun"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AgentRun_createdAt_idx" ON "AgentRun"("createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_orchestrationId_idx" ON "AgentRun"("orchestrationId");

-- CreateIndex
CREATE INDEX "AgentRun_assignmentId_idx" ON "AgentRun"("assignmentId");

-- CreateIndex
CREATE INDEX "AgentRun_oauthGrantId_createdAt_idx" ON "AgentRun"("oauthGrantId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_idx" ON "AgentRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentTool_workspaceId_idx" ON "AgentTool"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTool_workspace_name_key" ON "AgentTool"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AgentApproval_status_requestedAt_idx" ON "AgentApproval"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "AgentApproval_status_executeAfter_idx" ON "AgentApproval"("status", "executeAfter");

-- CreateIndex
CREATE INDEX "AgentApproval_status_expiresAt_idx" ON "AgentApproval"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentApproval_workspaceId_idx" ON "AgentApproval"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentMemory_scope_entityType_entityId_idx" ON "AgentMemory"("scope", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AgentMemory_workspaceId_idx" ON "AgentMemory"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMemory_scope_entityType_entityId_key_key" ON "AgentMemory"("workspaceId", "scope", "entityType", "entityId", "key");

-- CreateIndex
CREATE INDEX "PromptTemplate_feature_status_idx" ON "PromptTemplate"("feature", "status");

-- CreateIndex
CREATE INDEX "PromptTemplate_status_idx" ON "PromptTemplate"("status");

-- CreateIndex
CREATE INDEX "PromptTemplate_workspaceId_idx" ON "PromptTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "Goal_userId_status_idx" ON "Goal"("userId", "status");

-- CreateIndex
CREATE INDEX "Goal_period_idx" ON "Goal"("period");

-- CreateIndex
CREATE INDEX "Goal_workspaceId_idx" ON "Goal"("workspaceId");

-- CreateIndex
CREATE INDEX "DashboardLayout_workspaceId_idx" ON "DashboardLayout"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardLayout_workspace_userId_key" ON "DashboardLayout"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "DashboardView_userId_idx" ON "DashboardView"("userId");

-- CreateIndex
CREATE INDEX "DashboardView_workspaceId_idx" ON "DashboardView"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardView_userId_name_key" ON "DashboardView"("workspaceId", "userId", "name");

-- CreateIndex
CREATE INDEX "ScheduledReport_userId_idx" ON "ScheduledReport"("userId");

-- CreateIndex
CREATE INDEX "ScheduledReport_isActive_frequency_idx" ON "ScheduledReport"("isActive", "frequency");

-- CreateIndex
CREATE INDEX "ScheduledReport_workspaceId_idx" ON "ScheduledReport"("workspaceId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_type_createdAt_idx" ON "Notification"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_entityType_entityId_idx" ON "Notification"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_idx" ON "Notification"("workspaceId");

-- CreateIndex
CREATE INDEX "SavedViewAlert_userId_isActive_idx" ON "SavedViewAlert"("userId", "isActive");

-- CreateIndex
CREATE INDEX "SavedViewAlert_savedViewId_idx" ON "SavedViewAlert"("savedViewId");

-- CreateIndex
CREATE INDEX "SavedViewAlert_isActive_lastCheckedAt_idx" ON "SavedViewAlert"("isActive", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "SavedViewAlert_workspaceId_idx" ON "SavedViewAlert"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductTranslation_language_idx" ON "ProductTranslation"("language");

-- CreateIndex
CREATE INDEX "ProductTranslation_productId_idx" ON "ProductTranslation"("productId");

-- CreateIndex
CREATE INDEX "ProductTranslation_source_idx" ON "ProductTranslation"("source");

-- CreateIndex
CREATE INDEX "ProductTranslation_workspaceId_idx" ON "ProductTranslation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTranslation_productId_language_key" ON "ProductTranslation"("workspaceId", "productId", "language");

-- CreateIndex
CREATE INDEX "ProductRelation_fromProductId_type_idx" ON "ProductRelation"("fromProductId", "type");

-- CreateIndex
CREATE INDEX "ProductRelation_toProductId_type_idx" ON "ProductRelation"("toProductId", "type");

-- CreateIndex
CREATE INDEX "ProductRelation_workspaceId_idx" ON "ProductRelation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRelation_fromProductId_toProductId_type_key" ON "ProductRelation"("workspaceId", "fromProductId", "toProductId", "type");

-- CreateIndex
CREATE INDEX "ProductSeo_productId_idx" ON "ProductSeo"("productId");

-- CreateIndex
CREATE INDEX "ProductSeo_locale_idx" ON "ProductSeo"("locale");

-- CreateIndex
CREATE INDEX "ProductSeo_urlHandle_idx" ON "ProductSeo"("urlHandle");

-- CreateIndex
CREATE INDEX "ProductSeo_workspaceId_idx" ON "ProductSeo"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSeo_productId_locale_key" ON "ProductSeo"("workspaceId", "productId", "locale");

-- CreateIndex
CREATE INDEX "ProductCertificate_productId_idx" ON "ProductCertificate"("productId");

-- CreateIndex
CREATE INDEX "ProductCertificate_productId_certType_idx" ON "ProductCertificate"("productId", "certType");

-- CreateIndex
CREATE INDEX "ProductCertificate_expiresAt_idx" ON "ProductCertificate"("expiresAt");

-- CreateIndex
CREATE INDEX "ProductCertificate_workspaceId_idx" ON "ProductCertificate"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_channel_marketplace_attemptedAt_idx" ON "ChannelPublishAttempt"("channel", "marketplace", "attemptedAt");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_sku_attemptedAt_idx" ON "ChannelPublishAttempt"("sku", "attemptedAt");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_outcome_attemptedAt_idx" ON "ChannelPublishAttempt"("outcome", "attemptedAt");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_productId_idx" ON "ChannelPublishAttempt"("productId");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_workspaceId_idx" ON "ChannelPublishAttempt"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayCampaign_channelConnectionId_status_idx" ON "EbayCampaign"("channelConnectionId", "status");

-- CreateIndex
CREATE INDEX "EbayCampaign_marketplace_status_idx" ON "EbayCampaign"("marketplace", "status");

-- CreateIndex
CREATE INDEX "EbayCampaign_workspaceId_idx" ON "EbayCampaign"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayCampaign_channelConnectionId_externalCampaignId_key" ON "EbayCampaign"("workspaceId", "channelConnectionId", "externalCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayRateDiscoveryPlan_campaignId_key" ON "EbayRateDiscoveryPlan"("campaignId");

-- CreateIndex
CREATE INDEX "EbayRateDiscoveryPlan_status_idx" ON "EbayRateDiscoveryPlan"("status");

-- CreateIndex
CREATE INDEX "EbayRateDiscoveryPlan_workspaceId_idx" ON "EbayRateDiscoveryPlan"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayCampaignAutomationPolicy_campaignId_key" ON "EbayCampaignAutomationPolicy"("campaignId");

-- CreateIndex
CREATE INDEX "EbayCampaignAutomationPolicy_workspaceId_idx" ON "EbayCampaignAutomationPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayAdGroup_campaignId_status_idx" ON "EbayAdGroup"("campaignId", "status");

-- CreateIndex
CREATE INDEX "EbayAdGroup_workspaceId_idx" ON "EbayAdGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdGroup_campaignId_externalAdGroupId_key" ON "EbayAdGroup"("workspaceId", "campaignId", "externalAdGroupId");

-- CreateIndex
CREATE INDEX "EbayAd_listingId_idx" ON "EbayAd"("listingId");

-- CreateIndex
CREATE INDEX "EbayAd_productId_idx" ON "EbayAd"("productId");

-- CreateIndex
CREATE INDEX "EbayAd_marketplace_status_idx" ON "EbayAd"("marketplace", "status");

-- CreateIndex
CREATE INDEX "EbayAd_workspaceId_idx" ON "EbayAd"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAd_campaignId_listingId_key" ON "EbayAd"("workspaceId", "campaignId", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAd_campaignId_inventoryReference_key" ON "EbayAd"("workspaceId", "campaignId", "inventoryReference");

-- CreateIndex
CREATE INDEX "EbayKeyword_campaignId_status_idx" ON "EbayKeyword"("campaignId", "status");

-- CreateIndex
CREATE INDEX "EbayKeyword_text_idx" ON "EbayKeyword"("text");

-- CreateIndex
CREATE INDEX "EbayKeyword_workspaceId_idx" ON "EbayKeyword"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayKeyword_adGroupId_externalKeywordId_key" ON "EbayKeyword"("workspaceId", "adGroupId", "externalKeywordId");

-- CreateIndex
CREATE INDEX "EbayNegativeKeyword_campaignId_status_idx" ON "EbayNegativeKeyword"("campaignId", "status");

-- CreateIndex
CREATE INDEX "EbayNegativeKeyword_workspaceId_idx" ON "EbayNegativeKeyword"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayNegativeKeyword_campaignId_externalId_key" ON "EbayNegativeKeyword"("workspaceId", "campaignId", "externalId");

-- CreateIndex
CREATE INDEX "EbayAdsReportTask_status_lastPolledAt_idx" ON "EbayAdsReportTask"("status", "lastPolledAt");

-- CreateIndex
CREATE INDEX "EbayAdsReportTask_reportType_fundingModel_dateFrom_dateTo_idx" ON "EbayAdsReportTask"("reportType", "fundingModel", "dateFrom", "dateTo");

-- CreateIndex
CREATE INDEX "EbayAdsReportTask_workspaceId_idx" ON "EbayAdsReportTask"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsReportTask_workspace_externalTaskId_key" ON "EbayAdsReportTask"("workspaceId", "externalTaskId");

-- CreateIndex
CREATE INDEX "EbayAdsDailyPerformance_entityType_entityId_date_idx" ON "EbayAdsDailyPerformance"("entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "EbayAdsDailyPerformance_date_idx" ON "EbayAdsDailyPerformance"("date");

-- CreateIndex
CREATE INDEX "EbayAdsDailyPerformance_workspaceId_idx" ON "EbayAdsDailyPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsDailyPerformance_marketplace_fundingModel_enti_88283d238" ON "EbayAdsDailyPerformance"("workspaceId", "marketplace", "fundingModel", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "EbayListingIndex_matchStatus_idx" ON "EbayListingIndex"("matchStatus");

-- CreateIndex
CREATE INDEX "EbayListingIndex_endedAt_idx" ON "EbayListingIndex"("endedAt");

-- CreateIndex
CREATE INDEX "EbayListingIndex_workspaceId_idx" ON "EbayListingIndex"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayListingIndex_marketplace_itemId_key" ON "EbayListingIndex"("workspaceId", "marketplace", "itemId");

-- CreateIndex
CREATE INDEX "EbayListingEconomics_productId_idx" ON "EbayListingEconomics"("productId");

-- CreateIndex
CREATE INDEX "EbayListingEconomics_dataStatus_idx" ON "EbayListingEconomics"("dataStatus");

-- CreateIndex
CREATE INDEX "EbayListingEconomics_workspaceId_idx" ON "EbayListingEconomics"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayListingEconomics_marketplace_itemId_key" ON "EbayListingEconomics"("workspaceId", "marketplace", "itemId");

-- CreateIndex
CREATE INDEX "MarketingAutomationState_workspaceId_idx" ON "MarketingAutomationState"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAutomationState_workspace_channel_key" ON "MarketingAutomationState"("workspaceId", "channel");

-- CreateIndex
CREATE INDEX "MarketingSpendCeiling_workspaceId_idx" ON "MarketingSpendCeiling"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSpendCeiling_channel_marketplace_key" ON "MarketingSpendCeiling"("workspaceId", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "EbayAdsRule_enabled_mode_idx" ON "EbayAdsRule"("enabled", "mode");

-- CreateIndex
CREATE INDEX "EbayAdsRule_workspaceId_idx" ON "EbayAdsRule"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayAdsRuleVersion_ruleId_createdAt_idx" ON "EbayAdsRuleVersion"("ruleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EbayAdsRuleVersion_workspaceId_idx" ON "EbayAdsRuleVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsRuleVersion_ruleId_version_key" ON "EbayAdsRuleVersion"("workspaceId", "ruleId", "version");

-- CreateIndex
CREATE INDEX "EbayAdsRuleExecution_ruleId_createdAt_idx" ON "EbayAdsRuleExecution"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "EbayAdsRuleExecution_workspaceId_idx" ON "EbayAdsRuleExecution"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayAdsProposal_status_createdAt_idx" ON "EbayAdsProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EbayAdsProposal_workspaceId_idx" ON "EbayAdsProposal"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsProposal_workspace_proposedKey_key" ON "EbayAdsProposal"("workspaceId", "proposedKey");

-- CreateIndex
CREATE INDEX "EbayAdsDigest_workspaceId_idx" ON "EbayAdsDigest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsDigest_workspace_weekStart_key" ON "EbayAdsDigest"("workspaceId", "weekStart");

-- CreateIndex
CREATE INDEX "EbayWatcherStats_channelListingId_snapshotAt_idx" ON "EbayWatcherStats"("channelListingId", "snapshotAt");

-- CreateIndex
CREATE INDEX "EbayWatcherStats_workspaceId_idx" ON "EbayWatcherStats"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayMarkdown_channelListingId_startDate_idx" ON "EbayMarkdown"("channelListingId", "startDate");

-- CreateIndex
CREATE INDEX "EbayMarkdown_status_endDate_idx" ON "EbayMarkdown"("status", "endDate");

-- CreateIndex
CREATE INDEX "EbayMarkdown_workspaceId_idx" ON "EbayMarkdown"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayVolumePromotion_marketplace_status_idx" ON "EbayVolumePromotion"("marketplace", "status");

-- CreateIndex
CREATE INDEX "EbayVolumePromotion_workspaceId_idx" ON "EbayVolumePromotion"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayVolumeTierTemplate_workspaceId_idx" ON "EbayVolumeTierTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledProductChange_status_scheduledFor_idx" ON "ScheduledProductChange"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ScheduledProductChange_productId_status_idx" ON "ScheduledProductChange"("productId", "status");

-- CreateIndex
CREATE INDEX "ScheduledProductChange_workspaceId_idx" ON "ScheduledProductChange"("workspaceId");

-- CreateIndex
CREATE INDEX "AutomationRule_domain_enabled_idx" ON "AutomationRule"("domain", "enabled");

-- CreateIndex
CREATE INDEX "AutomationRule_trigger_idx" ON "AutomationRule"("trigger");

-- CreateIndex
CREATE INDEX "AutomationRule_workspaceId_idx" ON "AutomationRule"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignRuleAssignment_ruleId_kind_idx" ON "CampaignRuleAssignment"("ruleId", "kind");

-- CreateIndex
CREATE INDEX "CampaignRuleAssignment_campaignId_kind_idx" ON "CampaignRuleAssignment"("campaignId", "kind");

-- CreateIndex
CREATE INDEX "CampaignRuleAssignment_workspaceId_idx" ON "CampaignRuleAssignment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRuleAssignment_campaignId_ruleId_key" ON "CampaignRuleAssignment"("workspaceId", "campaignId", "ruleId");

-- CreateIndex
CREATE INDEX "AutomationRuleTemplate_domain_type_idx" ON "AutomationRuleTemplate"("domain", "type");

-- CreateIndex
CREATE INDEX "AutomationRuleTemplate_workspaceId_idx" ON "AutomationRuleTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "AutomationRuleExecution_ruleId_startedAt_idx" ON "AutomationRuleExecution"("ruleId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationRuleExecution_status_startedAt_idx" ON "AutomationRuleExecution"("status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationRuleExecution_workspaceId_idx" ON "AutomationRuleExecution"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsRuleSuggestion_status_createdAt_idx" ON "AdsRuleSuggestion"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsRuleSuggestion_status_lastSeenAt_idx" ON "AdsRuleSuggestion"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "AdsRuleSuggestion_ruleId_createdAt_idx" ON "AdsRuleSuggestion"("ruleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsRuleSuggestion_workspaceId_idx" ON "AdsRuleSuggestion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsRuleSuggestion_dedupe_key" ON "AdsRuleSuggestion"("workspaceId", "ruleId", "entityId", "proposedKey");

-- CreateIndex
CREATE INDEX "AdsSuggestionMute_scope_idx" ON "AdsSuggestionMute"("scope");

-- CreateIndex
CREATE INDEX "AdsSuggestionMute_workspaceId_idx" ON "AdsSuggestionMute"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsSuggestionMute_scope_entityType_entityId_key" ON "AdsSuggestionMute"("workspaceId", "scope", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "KeywordRank_keyword_marketplace_capturedAt_idx" ON "KeywordRank"("keyword", "marketplace", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "KeywordRank_marketplace_capturedAt_idx" ON "KeywordRank"("marketplace", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "KeywordRank_asin_idx" ON "KeywordRank"("asin");

-- CreateIndex
CREATE INDEX "KeywordRank_workspaceId_idx" ON "KeywordRank"("workspaceId");

-- CreateIndex
CREATE INDEX "Scenario_kind_idx" ON "Scenario"("kind");

-- CreateIndex
CREATE INDEX "Scenario_isSaved_updatedAt_idx" ON "Scenario"("isSaved", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Scenario_workspaceId_idx" ON "Scenario"("workspaceId");

-- CreateIndex
CREATE INDEX "ScenarioRun_scenarioId_startedAt_idx" ON "ScenarioRun"("scenarioId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "ScenarioRun_status_startedAt_idx" ON "ScenarioRun"("status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "ScenarioRun_workspaceId_idx" ON "ScenarioRun"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingReconciliation_channel_marketplace_reconciliationSta_idx" ON "ListingReconciliation"("channel", "marketplace", "reconciliationStatus");

-- CreateIndex
CREATE INDEX "ListingReconciliation_runId_idx" ON "ListingReconciliation"("runId");

-- CreateIndex
CREATE INDEX "ListingReconciliation_matchedProductId_idx" ON "ListingReconciliation"("matchedProductId");

-- CreateIndex
CREATE INDEX "ListingReconciliation_workspaceId_idx" ON "ListingReconciliation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingReconciliation_channel_marketplace_externalSku_key" ON "ListingReconciliation"("workspaceId", "channel", "marketplace", "externalSku");

-- CreateIndex
CREATE INDEX "FlatFilePullRecord_channel_marketplace_pulledAt_idx" ON "FlatFilePullRecord"("channel", "marketplace", "pulledAt");

-- CreateIndex
CREATE INDEX "FlatFilePullRecord_productType_pulledAt_idx" ON "FlatFilePullRecord"("productType", "pulledAt");

-- CreateIndex
CREATE INDEX "FlatFilePullRecord_workspaceId_idx" ON "FlatFilePullRecord"("workspaceId");

-- CreateIndex
CREATE INDEX "FlatFilePullJob_channel_marketplace_status_idx" ON "FlatFilePullJob"("channel", "marketplace", "status");

-- CreateIndex
CREATE INDEX "FlatFilePullJob_startedAt_idx" ON "FlatFilePullJob"("startedAt");

-- CreateIndex
CREATE INDEX "FlatFilePullJob_workspaceId_idx" ON "FlatFilePullJob"("workspaceId");

-- CreateIndex
CREATE INDEX "CatalogOrganizeSession_status_createdAt_idx" ON "CatalogOrganizeSession"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CatalogOrganizeSession_workspaceId_idx" ON "CatalogOrganizeSession"("workspaceId");

-- CreateIndex
CREATE INDEX "CatalogOrganizeChange_sessionId_idx" ON "CatalogOrganizeChange"("sessionId");

-- CreateIndex
CREATE INDEX "CatalogOrganizeChange_productId_idx" ON "CatalogOrganizeChange"("productId");

-- CreateIndex
CREATE INDEX "CatalogOrganizeChange_workspaceId_idx" ON "CatalogOrganizeChange"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductReadCache_status_idx" ON "ProductReadCache"("status");

-- CreateIndex
CREATE INDEX "ProductReadCache_brand_idx" ON "ProductReadCache"("brand");

-- CreateIndex
CREATE INDEX "ProductReadCache_productType_idx" ON "ProductReadCache"("productType");

-- CreateIndex
CREATE INDEX "ProductReadCache_familyId_idx" ON "ProductReadCache"("familyId");

-- CreateIndex
CREATE INDEX "ProductReadCache_workflowStageId_idx" ON "ProductReadCache"("workflowStageId");

-- CreateIndex
CREATE INDEX "ProductReadCache_isParent_idx" ON "ProductReadCache"("isParent");

-- CreateIndex
CREATE INDEX "ProductReadCache_parentId_idx" ON "ProductReadCache"("parentId");

-- CreateIndex
CREATE INDEX "ProductReadCache_totalStock_idx" ON "ProductReadCache"("totalStock");

-- CreateIndex
CREATE INDEX "ProductReadCache_updatedAt_idx" ON "ProductReadCache"("updatedAt" DESC);

-- CreateIndex
CREATE INDEX "ProductReadCache_deletedAt_idx" ON "ProductReadCache"("deletedAt");

-- CreateIndex
CREATE INDEX "ProductReadCache_photoCount_idx" ON "ProductReadCache"("photoCount");

-- CreateIndex
CREATE INDEX "ProductReadCache_channelCount_idx" ON "ProductReadCache"("channelCount");

-- CreateIndex
CREATE INDEX "ProductReadCache_variantCount_idx" ON "ProductReadCache"("variantCount");

-- CreateIndex
CREATE INDEX "ProductReadCache_driftCount_idx" ON "ProductReadCache"("driftCount");

-- CreateIndex
CREATE INDEX "ProductReadCache_primaryCategoryId_idx" ON "ProductReadCache"("primaryCategoryId");

-- CreateIndex
CREATE INDEX "ProductReadCache_asin_idx" ON "ProductReadCache"("asin");

-- CreateIndex
CREATE INDEX "ProductReadCache_categoryIds_idx" ON "ProductReadCache" USING GIN ("categoryIds");

-- CreateIndex
CREATE INDEX "ProductReadCache_rollupChannelKeys_idx" ON "ProductReadCache" USING GIN ("rollupChannelKeys");

-- CreateIndex
CREATE INDEX "ProductReadCache_workspaceId_idx" ON "ProductReadCache"("workspaceId");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE INDEX "Category_isActive_idx" ON "Category"("isActive");

-- CreateIndex
CREATE INDEX "Category_slug_idx" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_workspaceId_idx" ON "Category"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_parentId_slug_key" ON "Category"("workspaceId", "parentId", "slug");

-- CreateIndex
CREATE INDEX "CategoryClosure_descendantId_idx" ON "CategoryClosure"("descendantId");

-- CreateIndex
CREATE INDEX "CategoryClosure_ancestorId_depth_idx" ON "CategoryClosure"("ancestorId", "depth");

-- CreateIndex
CREATE INDEX "CategoryClosure_workspaceId_idx" ON "CategoryClosure"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductCategory_categoryId_idx" ON "ProductCategory"("categoryId");

-- CreateIndex
CREATE INDEX "ProductCategory_productId_isPrimary_idx" ON "ProductCategory"("productId", "isPrimary");

-- CreateIndex
CREATE INDEX "ProductCategory_workspaceId_idx" ON "ProductCategory"("workspaceId");

-- CreateIndex
CREATE INDEX "FnskuLabelTemplate_workspaceId_idx" ON "FnskuLabelTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductEvent_aggregateId_createdAt_idx" ON "ProductEvent"("aggregateId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProductEvent_aggregateType_aggregateId_idx" ON "ProductEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "ProductEvent_eventType_createdAt_idx" ON "ProductEvent"("eventType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProductEvent_createdAt_idx" ON "ProductEvent"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProductEvent_workspaceId_idx" ON "ProductEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "ListingQualitySnapshot_productId_channel_createdAt_idx" ON "ListingQualitySnapshot"("productId", "channel", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ListingQualitySnapshot_createdAt_idx" ON "ListingQualitySnapshot"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ListingQualitySnapshot_workspaceId_idx" ON "ListingQualitySnapshot"("workspaceId");

-- CreateIndex
CREATE INDEX "RoutingDecision_orderId_idx" ON "RoutingDecision"("orderId");

-- CreateIndex
CREATE INDEX "RoutingDecision_createdAt_idx" ON "RoutingDecision"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "RoutingDecision_workspaceId_idx" ON "RoutingDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "FeedTransformRule_channel_field_priority_idx" ON "FeedTransformRule"("channel", "field", "priority");

-- CreateIndex
CREATE INDEX "FeedTransformRule_workspaceId_idx" ON "FeedTransformRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedTransformRule_name_channel_marketplace_key" ON "FeedTransformRule"("workspaceId", "name", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "ChannelSchema_channel_marketplace_idx" ON "ChannelSchema"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "ChannelSchema_workspaceId_idx" ON "ChannelSchema"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelSchema_channel_marketplace_fieldKey_key" ON "ChannelSchema"("workspaceId", "channel", "marketplace", "fieldKey");

-- CreateIndex
CREATE INDEX "FbaReimbursement_approvalDate_idx" ON "FbaReimbursement"("approvalDate");

-- CreateIndex
CREATE INDEX "FbaReimbursement_sku_idx" ON "FbaReimbursement"("sku");

-- CreateIndex
CREATE INDEX "FbaReimbursement_marketplaceId_idx" ON "FbaReimbursement"("marketplaceId");

-- CreateIndex
CREATE INDEX "FbaReimbursement_workspaceId_idx" ON "FbaReimbursement"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaReimbursement_workspace_reimbursementId_key" ON "FbaReimbursement"("workspaceId", "reimbursementId");

-- CreateIndex
CREATE INDEX "FbaInventoryAdjustment_adjustedDate_idx" ON "FbaInventoryAdjustment"("adjustedDate");

-- CreateIndex
CREATE INDEX "FbaInventoryAdjustment_sku_idx" ON "FbaInventoryAdjustment"("sku");

-- CreateIndex
CREATE INDEX "FbaInventoryAdjustment_transactionType_idx" ON "FbaInventoryAdjustment"("transactionType");

-- CreateIndex
CREATE INDEX "FbaInventoryAdjustment_workspaceId_idx" ON "FbaInventoryAdjustment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaInventoryAdjustment_workspace_adjustmentId_key" ON "FbaInventoryAdjustment"("workspaceId", "adjustmentId");

-- CreateIndex
CREATE INDEX "MarketingCampaign_channel_status_idx" ON "MarketingCampaign"("channel", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_surface_status_idx" ON "MarketingCampaign"("surface", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_primaryMarketplace_status_idx" ON "MarketingCampaign"("primaryMarketplace", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_startDate_endDate_idx" ON "MarketingCampaign"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "MarketingCampaign_lastSyncStatus_idx" ON "MarketingCampaign"("lastSyncStatus");

-- CreateIndex
CREATE INDEX "MarketingCampaign_workspaceId_idx" ON "MarketingCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "MarketingCampaignLink_marketplace_status_idx" ON "MarketingCampaignLink"("marketplace", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaignLink_workspaceId_idx" ON "MarketingCampaignLink"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignLink_campaignId_marketplace_key" ON "MarketingCampaignLink"("workspaceId", "campaignId", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignLink_externalId_marketplace_key" ON "MarketingCampaignLink"("workspaceId", "externalId", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsCampaignDetail_campaignId_key" ON "AmazonAdsCampaignDetail"("campaignId");

-- CreateIndex
CREATE INDEX "AmazonAdsCampaignDetail_adProduct_idx" ON "AmazonAdsCampaignDetail"("adProduct");

-- CreateIndex
CREATE INDEX "AmazonAdsCampaignDetail_profileId_idx" ON "AmazonAdsCampaignDetail"("profileId");

-- CreateIndex
CREATE INDEX "AmazonAdsCampaignDetail_workspaceId_idx" ON "AmazonAdsCampaignDetail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayPromotedDetail_campaignId_key" ON "EbayPromotedDetail"("campaignId");

-- CreateIndex
CREATE INDEX "EbayPromotedDetail_fundingStrategy_idx" ON "EbayPromotedDetail"("fundingStrategy");

-- CreateIndex
CREATE INDEX "EbayPromotedDetail_workspaceId_idx" ON "EbayPromotedDetail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountDetail_campaignId_key" ON "DiscountDetail"("campaignId");

-- CreateIndex
CREATE INDEX "DiscountDetail_discountType_idx" ON "DiscountDetail"("discountType");

-- CreateIndex
CREATE INDEX "DiscountDetail_workspaceId_idx" ON "DiscountDetail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAdsDetail_campaignId_key" ON "ExternalAdsDetail"("campaignId");

-- CreateIndex
CREATE INDEX "ExternalAdsDetail_platform_idx" ON "ExternalAdsDetail"("platform");

-- CreateIndex
CREATE INDEX "ExternalAdsDetail_workspaceId_idx" ON "ExternalAdsDetail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPushDetail_campaignId_key" ON "ContentPushDetail"("campaignId");

-- CreateIndex
CREATE INDEX "ContentPushDetail_contentType_idx" ON "ContentPushDetail"("contentType");

-- CreateIndex
CREATE INDEX "ContentPushDetail_workspaceId_idx" ON "ContentPushDetail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDetail_campaignId_key" ON "OutreachDetail"("campaignId");

-- CreateIndex
CREATE INDEX "OutreachDetail_mode_idx" ON "OutreachDetail"("mode");

-- CreateIndex
CREATE INDEX "OutreachDetail_workspaceId_idx" ON "OutreachDetail"("workspaceId");

-- CreateIndex
CREATE INDEX "AdMutation_entityType_entityId_field_state_idx" ON "AdMutation"("entityType", "entityId", "field", "state");

-- CreateIndex
CREATE INDEX "AdMutation_entityType_entityId_state_idx" ON "AdMutation"("entityType", "entityId", "state");

-- CreateIndex
CREATE INDEX "AdMutation_changeSetId_idx" ON "AdMutation"("changeSetId");

-- CreateIndex
CREATE INDEX "AdMutation_state_holdUntil_idx" ON "AdMutation"("state", "holdUntil");

-- CreateIndex
CREATE INDEX "AdMutation_workspaceId_idx" ON "AdMutation"("workspaceId");

-- CreateIndex
CREATE INDEX "AdBlueprintApplication_blueprintId_idx" ON "AdBlueprintApplication"("blueprintId");

-- CreateIndex
CREATE INDEX "AdBlueprintApplication_status_idx" ON "AdBlueprintApplication"("status");

-- CreateIndex
CREATE INDEX "AdBlueprintApplication_marketplace_productToken_status_idx" ON "AdBlueprintApplication"("marketplace", "productToken", "status");

-- CreateIndex
CREATE INDEX "AdBlueprintApplication_workspaceId_idx" ON "AdBlueprintApplication"("workspaceId");

-- CreateIndex
CREATE INDEX "AdKeywordProtection_mode_term_idx" ON "AdKeywordProtection"("mode", "term");

-- CreateIndex
CREATE INDEX "AdKeywordProtection_marketplace_idx" ON "AdKeywordProtection"("marketplace");

-- CreateIndex
CREATE INDEX "AdKeywordProtection_campaignId_idx" ON "AdKeywordProtection"("campaignId");

-- CreateIndex
CREATE INDEX "AdKeywordProtection_workspaceId_idx" ON "AdKeywordProtection"("workspaceId");

-- CreateIndex
CREATE INDEX "AdNegativeReview_campaignId_idx" ON "AdNegativeReview"("campaignId");

-- CreateIndex
CREATE INDEX "AdNegativeReview_workspaceId_idx" ON "AdNegativeReview"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdNegativeReview_protectedTerm_campaignId_key" ON "AdNegativeReview"("workspaceId", "protectedTerm", "campaignId");

-- CreateIndex
CREATE INDEX "AdBlueprint_marketplace_idx" ON "AdBlueprint"("marketplace");

-- CreateIndex
CREATE INDEX "AdBlueprint_workspaceId_idx" ON "AdBlueprint"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdBlueprint_workspace_name_key" ON "AdBlueprint"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "CampaignTarget_campaignId_kind_idx" ON "CampaignTarget"("campaignId", "kind");

-- CreateIndex
CREATE INDEX "CampaignTarget_campaignId_isNegative_idx" ON "CampaignTarget"("campaignId", "isNegative");

-- CreateIndex
CREATE INDEX "CampaignTarget_externalTargetId_idx" ON "CampaignTarget"("externalTargetId");

-- CreateIndex
CREATE INDEX "CampaignTarget_workspaceId_idx" ON "CampaignTarget"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignBudget_enabled_lastRebalancedAt_idx" ON "CampaignBudget"("enabled", "lastRebalancedAt");

-- CreateIndex
CREATE INDEX "CampaignBudget_workspaceId_idx" ON "CampaignBudget"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignBudgetAllocation_budgetId_idx" ON "CampaignBudgetAllocation"("budgetId");

-- CreateIndex
CREATE INDEX "CampaignBudgetAllocation_channel_marketplace_idx" ON "CampaignBudgetAllocation"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "CampaignBudgetAllocation_workspaceId_idx" ON "CampaignBudgetAllocation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignBudgetAllocation_campaignId_key" ON "CampaignBudgetAllocation"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignBudgetRebalance_budgetId_createdAt_idx" ON "CampaignBudgetRebalance"("budgetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignBudgetRebalance_workspaceId_idx" ON "CampaignBudgetRebalance"("workspaceId");

-- CreateIndex
CREATE INDEX "CampaignMetric_campaignId_date_idx" ON "CampaignMetric"("campaignId", "date");

-- CreateIndex
CREATE INDEX "CampaignMetric_marketplace_date_channel_idx" ON "CampaignMetric"("marketplace", "date", "channel");

-- CreateIndex
CREATE INDEX "CampaignMetric_linkId_date_idx" ON "CampaignMetric"("linkId", "date");

-- CreateIndex
CREATE INDEX "CampaignMetric_workspaceId_idx" ON "CampaignMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMetric_channel_entityType_entityId_date_key" ON "CampaignMetric"("workspaceId", "channel", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "CampaignAction_executionId_createdAt_idx" ON "CampaignAction"("executionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignAction_entityType_entityId_createdAt_idx" ON "CampaignAction"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignAction_campaignId_createdAt_idx" ON "CampaignAction"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignAction_createdAt_idx" ON "CampaignAction"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignAction_workspaceId_idx" ON "CampaignAction"("workspaceId");

-- CreateIndex
CREATE INDEX "CalendarEntry_startsAt_endsAt_idx" ON "CalendarEntry"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "CalendarEntry_campaignId_idx" ON "CalendarEntry"("campaignId");

-- CreateIndex
CREATE INDEX "CalendarEntry_retailEventId_idx" ON "CalendarEntry"("retailEventId");

-- CreateIndex
CREATE INDEX "CalendarEntry_workspaceId_idx" ON "CalendarEntry"("workspaceId");

-- CreateIndex
CREATE INDEX "AdSchedule_enabled_idx" ON "AdSchedule"("enabled");

-- CreateIndex
CREATE INDEX "AdSchedule_groupId_idx" ON "AdSchedule"("groupId");

-- CreateIndex
CREATE INDEX "AdSchedule_workspaceId_idx" ON "AdSchedule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSchedule_campaignId_key" ON "AdSchedule"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "RankScheduleGroup_marketplace_idx" ON "RankScheduleGroup"("marketplace");

-- CreateIndex
CREATE INDEX "RankScheduleGroup_workspaceId_idx" ON "RankScheduleGroup"("workspaceId");

-- CreateIndex
CREATE INDEX "RankScheduleEvent_groupId_startsAt_idx" ON "RankScheduleEvent"("groupId", "startsAt");

-- CreateIndex
CREATE INDEX "RankScheduleEvent_enabled_startsAt_endsAt_idx" ON "RankScheduleEvent"("enabled", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "RankScheduleEvent_workspaceId_idx" ON "RankScheduleEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "RankScheduleVersion_groupId_createdAt_idx" ON "RankScheduleVersion"("groupId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RankScheduleVersion_workspaceId_idx" ON "RankScheduleVersion"("workspaceId");

-- CreateIndex
CREATE INDEX "BudgetSchedule_enabled_idx" ON "BudgetSchedule"("enabled");

-- CreateIndex
CREATE INDEX "BudgetSchedule_kind_idx" ON "BudgetSchedule"("kind");

-- CreateIndex
CREATE INDEX "BudgetSchedule_workspaceId_idx" ON "BudgetSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "AutopilotPlan_enabled_idx" ON "AutopilotPlan"("enabled");

-- CreateIndex
CREATE INDEX "AutopilotPlan_marketplace_idx" ON "AutopilotPlan"("marketplace");

-- CreateIndex
CREATE INDEX "AutopilotPlan_workspaceId_idx" ON "AutopilotPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "AutopilotDecision_planId_at_idx" ON "AutopilotDecision"("planId", "at");

-- CreateIndex
CREATE INDEX "AutopilotDecision_status_idx" ON "AutopilotDecision"("status");

-- CreateIndex
CREATE INDEX "AutopilotDecision_workspaceId_idx" ON "AutopilotDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "RankTarget_workspaceId_idx" ON "RankTarget"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RankTarget_workspace_key_key" ON "RankTarget"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "RankScheduleTemplate_name_idx" ON "RankScheduleTemplate"("name");

-- CreateIndex
CREATE INDEX "RankScheduleTemplate_workspaceId_idx" ON "RankScheduleTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductRankPlan_enabled_idx" ON "ProductRankPlan"("enabled");

-- CreateIndex
CREATE INDEX "ProductRankPlan_marketplace_enabled_idx" ON "ProductRankPlan"("marketplace", "enabled");

-- CreateIndex
CREATE INDEX "ProductRankPlan_workspaceId_idx" ON "ProductRankPlan"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRankPlan_productId_marketplace_key" ON "ProductRankPlan"("workspaceId", "productId", "marketplace");

-- CreateIndex
CREATE INDEX "AdAudience_status_idx" ON "AdAudience"("status");

-- CreateIndex
CREATE INDEX "AdAudience_audienceType_idx" ON "AdAudience"("audienceType");

-- CreateIndex
CREATE INDEX "AdAudience_workspaceId_idx" ON "AdAudience"("workspaceId");

-- CreateIndex
CREATE INDEX "AdBudgetPlan_month_marketplace_idx" ON "AdBudgetPlan"("month", "marketplace");

-- CreateIndex
CREATE INDEX "AdBudgetPlan_workspaceId_idx" ON "AdBudgetPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "AdProductGoal_status_createdAt_idx" ON "AdProductGoal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdProductGoal_marketplace_idx" ON "AdProductGoal"("marketplace");

-- CreateIndex
CREATE INDEX "AdProductGoal_workspaceId_idx" ON "AdProductGoal"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierContact_supplierId_idx" ON "SupplierContact"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierContact_workspaceId_idx" ON "SupplierContact"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierComm_supplierId_createdAt_idx" ON "SupplierComm"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "SupplierComm_workspaceId_idx" ON "SupplierComm"("workspaceId");

-- CreateIndex
CREATE INDEX "SupplierFollowUp_supplierId_idx" ON "SupplierFollowUp"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierFollowUp_status_dueDate_idx" ON "SupplierFollowUp"("status", "dueDate");

-- CreateIndex
CREATE INDEX "SupplierFollowUp_workspaceId_idx" ON "SupplierFollowUp"("workspaceId");

-- CreateIndex
CREATE INDEX "DevelopmentProject_status_idx" ON "DevelopmentProject"("status");

-- CreateIndex
CREATE INDEX "DevelopmentProject_workspaceId_idx" ON "DevelopmentProject"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DevelopmentProject_workspace_code_key" ON "DevelopmentProject"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "DevelopmentProjectSupplier_supplierId_idx" ON "DevelopmentProjectSupplier"("supplierId");

-- CreateIndex
CREATE INDEX "DevelopmentProjectSupplier_workspaceId_idx" ON "DevelopmentProjectSupplier"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DevelopmentProjectSupplier_projectId_supplierId_key" ON "DevelopmentProjectSupplier"("workspaceId", "projectId", "supplierId");

-- CreateIndex
CREATE INDEX "DevelopmentAttachment_projectId_idx" ON "DevelopmentAttachment"("projectId");

-- CreateIndex
CREATE INDEX "DevelopmentAttachment_workspaceId_idx" ON "DevelopmentAttachment"("workspaceId");

-- CreateIndex
CREATE INDEX "DevelopmentCertification_projectId_idx" ON "DevelopmentCertification"("projectId");

-- CreateIndex
CREATE INDEX "DevelopmentCertification_workspaceId_idx" ON "DevelopmentCertification"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsAutomationState_workspaceId_idx" ON "AdsAutomationState"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonReportRun_reportType_requestedAt_idx" ON "AmazonReportRun"("reportType", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonReportRun_marketplace_reportType_idx" ON "AmazonReportRun"("marketplace", "reportType");

-- CreateIndex
CREATE INDEX "AmazonReportRun_status_requestedAt_idx" ON "AmazonReportRun"("status", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonReportRun_workspaceId_idx" ON "AmazonReportRun"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonReportRun_workspace_reportId_key" ON "AmazonReportRun"("workspaceId", "reportId");

-- CreateIndex
CREATE INDEX "SharedListingMembership_channelConnectionId_idx" ON "SharedListingMembership"("channelConnectionId");

-- CreateIndex
CREATE INDEX "SharedListingMembership_sku_marketplace_idx" ON "SharedListingMembership"("sku", "marketplace");

-- CreateIndex
CREATE INDEX "SharedListingMembership_productId_idx" ON "SharedListingMembership"("productId");

-- CreateIndex
CREATE INDEX "SharedListingMembership_workspaceId_idx" ON "SharedListingMembership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedListingMembership_marketplace_itemId_sku_key" ON "SharedListingMembership"("workspaceId", "marketplace", "itemId", "sku");

-- CreateIndex
CREATE INDEX "SyncChannelPolicy_channelConnectionId_idx" ON "SyncChannelPolicy"("channelConnectionId");

-- CreateIndex
CREATE INDEX "SyncChannelPolicy_workspaceId_idx" ON "SyncChannelPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncChannelPolicy_channel_marketplace_conn_key" ON "SyncChannelPolicy"("workspaceId", "channel", "marketplace", "channelConnectionId");

-- CreateIndex
CREATE INDEX "SyncControlAudit_scopeType_scopeId_createdAt_idx" ON "SyncControlAudit"("scopeType", "scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncControlAudit_createdAt_idx" ON "SyncControlAudit"("createdAt");

-- CreateIndex
CREATE INDEX "SyncControlAudit_workspaceId_idx" ON "SyncControlAudit"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayDescriptionTheme_isDefault_active_idx" ON "EbayDescriptionTheme"("isDefault", "active");

-- CreateIndex
CREATE INDEX "EbayDescriptionTheme_workspaceId_idx" ON "EbayDescriptionTheme"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayDescriptionTheme_workspace_name_key" ON "EbayDescriptionTheme"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AmazonTemplateVault_marketplace_idx" ON "AmazonTemplateVault"("marketplace");

-- CreateIndex
CREATE INDEX "AmazonTemplateVault_workspaceId_idx" ON "AmazonTemplateVault"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonTemplateVault_workspace_templateIdentifier_key" ON "AmazonTemplateVault"("workspaceId", "templateIdentifier");

-- CreateIndex
CREATE INDEX "ChannelMappingSet_workspaceId_idx" ON "ChannelMappingSet"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelMappingSet_channel_marketplace_formKind_formKey_stat_idx" ON "ChannelMappingSet"("channel", "marketplace", "formKind", "formKey", "status");

-- CreateIndex
CREATE INDEX "ChannelMappingSet_templateIdentifier_idx" ON "ChannelMappingSet"("templateIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMappingSet_workspaceId_channel_marketplace_formKind__key" ON "ChannelMappingSet"("workspaceId", "channel", "marketplace", "formKind", "formKey", "version");

-- CreateIndex
CREATE INDEX "ChannelMappingField_setId_idx" ON "ChannelMappingField"("setId");

-- CreateIndex
CREATE INDEX "ChannelMappingField_workspaceId_idx" ON "ChannelMappingField"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMappingField_workspaceId_setId_channelKey_key" ON "ChannelMappingField"("workspaceId", "setId", "channelKey");

-- CreateIndex
CREATE INDEX "ChannelMappingUse_setId_createdAt_idx" ON "ChannelMappingUse"("setId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelMappingUse_workspaceId_idx" ON "ChannelMappingUse"("workspaceId");

-- CreateIndex
CREATE INDEX "AmazonFamilyWorkbook_marketplace_idx" ON "AmazonFamilyWorkbook"("marketplace");

-- CreateIndex
CREATE INDEX "AmazonFamilyWorkbook_workspaceId_idx" ON "AmazonFamilyWorkbook"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonFamilyWorkbook_familyKey_marketplace_key" ON "AmazonFamilyWorkbook"("workspaceId", "familyKey", "marketplace");

-- CreateIndex
CREATE INDEX "ReportShareLink_createdBy_createdAt_idx" ON "ReportShareLink"("createdBy", "createdAt");

-- CreateIndex
CREATE INDEX "ReportShareLink_expiresAt_idx" ON "ReportShareLink"("expiresAt");

-- CreateIndex
CREATE INDEX "ReportShareLink_workspaceId_idx" ON "ReportShareLink"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportShareLink_workspace_tokenHash_key" ON "ReportShareLink"("workspaceId", "tokenHash");

-- CreateIndex
CREATE INDEX "SavedReport_ownerId_isArchived_updatedAt_idx" ON "SavedReport"("ownerId", "isArchived", "updatedAt");

-- CreateIndex
CREATE INDEX "SavedReport_reportId_idx" ON "SavedReport"("reportId");

-- CreateIndex
CREATE INDEX "SavedReport_workspaceId_idx" ON "SavedReport"("workspaceId");

-- CreateIndex
CREATE INDEX "SavedReportVersion_savedReportId_createdAt_idx" ON "SavedReportVersion"("savedReportId", "createdAt");

-- CreateIndex
CREATE INDEX "SavedReportVersion_workspaceId_idx" ON "SavedReportVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedReportVersion_savedReportId_version_key" ON "SavedReportVersion"("workspaceId", "savedReportId", "version");

-- CreateIndex
CREATE INDEX "ReportSchedule_isActive_frequency_hourLocal_idx" ON "ReportSchedule"("isActive", "frequency", "hourLocal");

-- CreateIndex
CREATE INDEX "ReportSchedule_savedReportId_idx" ON "ReportSchedule"("savedReportId");

-- CreateIndex
CREATE INDEX "ReportSchedule_workspaceId_idx" ON "ReportSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "ReportDelivery_scheduleId_createdAt_idx" ON "ReportDelivery"("scheduleId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportDelivery_status_createdAt_idx" ON "ReportDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReportDelivery_workspaceId_idx" ON "ReportDelivery"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsConsoleImport_status_createdAt_idx" ON "AdsConsoleImport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdsConsoleImport_workspaceId_idx" ON "AdsConsoleImport"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsConsoleRow_importId_searchTerm_idx" ON "AdsConsoleRow"("importId", "searchTerm");

-- CreateIndex
CREATE INDEX "AdsConsoleRow_marketplace_windowStart_idx" ON "AdsConsoleRow"("marketplace", "windowStart");

-- CreateIndex
CREATE INDEX "AdsConsoleRow_workspaceId_idx" ON "AdsConsoleRow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsConsoleRow_natural_key" ON "AdsConsoleRow"("workspaceId", "importId", "windowStart", "windowEnd", "campaignId", "adGroupId", "adId", "targetId", "searchTerm", "placement", "marketplace");

-- CreateIndex
CREATE INDEX "CustomMetric_reportId_idx" ON "CustomMetric"("reportId");

-- CreateIndex
CREATE INDEX "CustomMetric_workspaceId_idx" ON "CustomMetric"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomMetric_reportId_name_key" ON "CustomMetric"("workspaceId", "reportId", "name");

-- CreateIndex
CREATE INDEX "AgentCharter_tier_domain_enabled_idx" ON "AgentCharter"("tier", "domain", "enabled");

-- CreateIndex
CREATE INDEX "AgentCharter_templateKey_idx" ON "AgentCharter"("templateKey");

-- CreateIndex
CREATE INDEX "AgentCharter_workspaceId_idx" ON "AgentCharter"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCharter_key_version_key" ON "AgentCharter"("workspaceId", "key", "version");

-- CreateIndex
CREATE INDEX "AgentCharterRevision_charterKey_activatedAt_idx" ON "AgentCharterRevision"("charterKey", "activatedAt");

-- CreateIndex
CREATE INDEX "AgentCharterRevision_workspaceId_idx" ON "AgentCharterRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCharterRevision_charterKey_revision_key" ON "AgentCharterRevision"("workspaceId", "charterKey", "revision");

-- CreateIndex
CREATE INDEX "AgentEvalRun_charterKey_createdAt_idx" ON "AgentEvalRun"("charterKey", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvalRun_revisionId_idx" ON "AgentEvalRun"("revisionId");

-- CreateIndex
CREATE INDEX "AgentEvalRun_workspaceId_idx" ON "AgentEvalRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentControlAudit_charterKey_createdAt_idx" ON "AgentControlAudit"("charterKey", "createdAt");

-- CreateIndex
CREATE INDEX "AgentControlAudit_workspaceId_idx" ON "AgentControlAudit"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentObservation_expiresAt_idx" ON "AgentObservation"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentObservation_workspaceId_idx" ON "AgentObservation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentObservation_key_entityType_entityId_marketplace_key" ON "AgentObservation"("workspaceId", "key", "entityType", "entityId", "marketplace");

-- CreateIndex
CREATE INDEX "AgentFinding_domain_status_createdAt_idx" ON "AgentFinding"("domain", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentFinding_entityType_entityId_idx" ON "AgentFinding"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AgentFinding_planId_idx" ON "AgentFinding"("planId");

-- CreateIndex
CREATE INDEX "AgentFinding_workspaceId_idx" ON "AgentFinding"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentFinding_dedupe" ON "AgentFinding"("workspaceId", "charterKey", "entityType", "entityId", "dedupeKey");

-- CreateIndex
CREATE INDEX "AgentPlan_domain_status_createdAt_idx" ON "AgentPlan"("domain", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentPlan_workspaceId_idx" ON "AgentPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentStrategy_status_periodStart_idx" ON "AgentStrategy"("status", "periodStart");

-- CreateIndex
CREATE INDEX "AgentStrategy_workspaceId_idx" ON "AgentStrategy"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentStep_agentRunId_idx" ON "AgentStep"("agentRunId");

-- CreateIndex
CREATE INDEX "AgentStep_workspaceId_idx" ON "AgentStep"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_agentRunId_seq_key" ON "AgentStep"("workspaceId", "agentRunId", "seq");

-- CreateIndex
CREATE INDEX "AgentExemplar_charterKey_label_active_idx" ON "AgentExemplar"("charterKey", "label", "active");

-- CreateIndex
CREATE INDEX "AgentExemplar_workspaceId_idx" ON "AgentExemplar"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentScorecard_charterKey_periodEnd_idx" ON "AgentScorecard"("charterKey", "periodEnd");

-- CreateIndex
CREATE INDEX "AgentScorecard_workspaceId_idx" ON "AgentScorecard"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentScorecard_charterKey_periodStart_periodEnd_key" ON "AgentScorecard"("workspaceId", "charterKey", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "GraphEdge_fromType_fromId_relation_idx" ON "GraphEdge"("fromType", "fromId", "relation");

-- CreateIndex
CREATE INDEX "GraphEdge_toType_toId_relation_idx" ON "GraphEdge"("toType", "toId", "relation");

-- CreateIndex
CREATE INDEX "GraphEdge_relation_validTo_idx" ON "GraphEdge"("relation", "validTo");

-- CreateIndex
CREATE INDEX "GraphEdge_workspaceId_idx" ON "GraphEdge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdge_unique" ON "GraphEdge"("workspaceId", "fromType", "fromId", "toType", "toId", "relation");

-- CreateIndex
CREATE INDEX "AgentFleetState_workspaceId_idx" ON "AgentFleetState"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentShadowGrade_engineKey_agrees_idx" ON "AgentShadowGrade"("engineKey", "agrees");

-- CreateIndex
CREATE INDEX "AgentShadowGrade_workspaceId_idx" ON "AgentShadowGrade"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentShadowGrade_workspace_findingId_key" ON "AgentShadowGrade"("workspaceId", "findingId");

-- CreateIndex
CREATE INDEX "AgentWorkflow_workspaceId_idx" ON "AgentWorkflow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflow_workspace_key_key" ON "AgentWorkflow"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AgentWorkflowRevision_workflowKey_activatedAt_idx" ON "AgentWorkflowRevision"("workflowKey", "activatedAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowRevision_workspaceId_idx" ON "AgentWorkflowRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflowRevision_workflowKey_revision_key" ON "AgentWorkflowRevision"("workspaceId", "workflowKey", "revision");

-- CreateIndex
CREATE INDEX "AgentAssignment_state_createdAt_idx" ON "AgentAssignment"("state", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAssignment_charterKey_createdAt_idx" ON "AgentAssignment"("charterKey", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAssignment_workspaceId_idx" ON "AgentAssignment"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentFindingRun_runId_idx" ON "AgentFindingRun"("runId");

-- CreateIndex
CREATE INDEX "AgentFindingRun_workspaceId_idx" ON "AgentFindingRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsHarvestPolicy_kind_scopeGrain_idx" ON "AdsHarvestPolicy"("kind", "scopeGrain");

-- CreateIndex
CREATE INDEX "AdsHarvestPolicy_workspaceId_idx" ON "AdsHarvestPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsHarvestPolicy_scopeGrain_scopeId_kind_key" ON "AdsHarvestPolicy"("workspaceId", "scopeGrain", "scopeId", "kind");

-- CreateIndex
CREATE INDEX "AdsHarvestDestination_adGroupId_idx" ON "AdsHarvestDestination"("adGroupId");

-- CreateIndex
CREATE INDEX "AdsHarvestDestination_workspaceId_idx" ON "AdsHarvestDestination"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsHarvestDestination_scopeGrain_scopeId_matchType_key" ON "AdsHarvestDestination"("workspaceId", "scopeGrain", "scopeId", "matchType");

-- CreateIndex
CREATE INDEX "SqpReportRequest_status_requestedAt_idx" ON "SqpReportRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "SqpReportRequest_marketplace_startDate_idx" ON "SqpReportRequest"("marketplace", "startDate");

-- CreateIndex
CREATE INDEX "SqpReportRequest_requestedAt_idx" ON "SqpReportRequest"("requestedAt");

-- CreateIndex
CREATE INDEX "SqpReportRequest_workspaceId_idx" ON "SqpReportRequest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SqpReportRequest_workspace_reportId_key" ON "SqpReportRequest"("workspaceId", "reportId");

-- CreateIndex
CREATE INDEX "AdSpendCeiling_enabled_idx" ON "AdSpendCeiling"("enabled");

-- CreateIndex
CREATE INDEX "AdSpendCeiling_workspaceId_idx" ON "AdSpendCeiling"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpendCeiling_grain_scopeId_key" ON "AdSpendCeiling"("workspaceId", "grain", "scopeId");

-- CreateIndex
CREATE INDEX "AdBidPolicy_enabled_idx" ON "AdBidPolicy"("enabled");

-- CreateIndex
CREATE INDEX "AdBidPolicy_workspaceId_idx" ON "AdBidPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdBidPolicy_grain_scopeId_key" ON "AdBidPolicy"("workspaceId", "grain", "scopeId");

-- CreateIndex
CREATE INDEX "AdWriteRefusal_deniedAt_createdAt_idx" ON "AdWriteRefusal"("deniedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AdWriteRefusal_campaignId_createdAt_idx" ON "AdWriteRefusal"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "AdWriteRefusal_createdAt_idx" ON "AdWriteRefusal"("createdAt");

-- CreateIndex
CREATE INDEX "AdWriteRefusal_workspaceId_idx" ON "AdWriteRefusal"("workspaceId");

-- CreateIndex
CREATE INDEX "AutomationRefusalDaily_dayUtc_reason_idx" ON "AutomationRefusalDaily"("dayUtc", "reason");

-- CreateIndex
CREATE INDEX "AutomationRefusalDaily_actorId_dayUtc_idx" ON "AutomationRefusalDaily"("actorId", "dayUtc");

-- CreateIndex
CREATE INDEX "AutomationRefusalDaily_workspaceId_idx" ON "AutomationRefusalDaily"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRefusalDaily_actorKind_actorId_dayUtc_reason_key" ON "AutomationRefusalDaily"("workspaceId", "actorKind", "actorId", "dayUtc", "reason");

-- CreateIndex
CREATE INDEX "KeywordBidProposal_marketplace_status_proposedAt_idx" ON "KeywordBidProposal"("marketplace", "status", "proposedAt");

-- CreateIndex
CREATE INDEX "KeywordBidProposal_status_proposedAt_idx" ON "KeywordBidProposal"("status", "proposedAt");

-- CreateIndex
CREATE INDEX "KeywordBidProposal_term_marketplace_idx" ON "KeywordBidProposal"("term", "marketplace");

-- CreateIndex
CREATE INDEX "KeywordBidProposal_workspaceId_idx" ON "KeywordBidProposal"("workspaceId");

-- CreateIndex
CREATE INDEX "EventOutbox_publishedAt_occurredAt_idx" ON "EventOutbox"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "EventOutbox_type_occurredAt_idx" ON "EventOutbox"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "EventOutbox_subject_idx" ON "EventOutbox"("subject");

-- CreateIndex
CREATE INDEX "EventOutbox_workspaceId_idx" ON "EventOutbox"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EventOutbox_workspace_eventId_key" ON "EventOutbox"("workspaceId", "eventId");

-- CreateIndex
CREATE INDEX "CategoryChannelMapping_channel_marketplace_idx" ON "CategoryChannelMapping"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "CategoryChannelMapping_channel_marketplace_channelCategoryI_idx" ON "CategoryChannelMapping"("channel", "marketplace", "channelCategoryId");

-- CreateIndex
CREATE INDEX "CategoryChannelMapping_categoryId_idx" ON "CategoryChannelMapping"("categoryId");

-- CreateIndex
CREATE INDEX "CategoryChannelMapping_workspaceId_idx" ON "CategoryChannelMapping"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryChannelMapping_categoryId_channel_marketplace_key" ON "CategoryChannelMapping"("workspaceId", "categoryId", "channel", "marketplace");

-- CreateIndex
CREATE INDEX "CellFormula_productId_idx" ON "CellFormula"("productId");

-- CreateIndex
CREATE INDEX "CellFormula_productId_scope_idx" ON "CellFormula"("productId", "scope");

-- CreateIndex
CREATE INDEX "CellFormula_fieldKey_idx" ON "CellFormula"("fieldKey");

-- CreateIndex
CREATE INDEX "CellFormula_workspaceId_idx" ON "CellFormula"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CellFormula_productId_scope_channel_marketplace_local_81ce279a6" ON "CellFormula"("workspaceId", "productId", "scope", "channel", "marketplace", "locale", "channelConnectionId", "aliasKey", "fieldKey");

-- CreateIndex
CREATE INDEX "MasterFieldRule_fieldKey_idx" ON "MasterFieldRule"("fieldKey");

-- CreateIndex
CREATE INDEX "MasterFieldRule_workspaceId_idx" ON "MasterFieldRule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterFieldRule_productType_fieldKey_key" ON "MasterFieldRule"("workspaceId", "productType", "fieldKey");

-- CreateIndex
CREATE INDEX "MasterFieldRuleRevision_productType_fieldKey_idx" ON "MasterFieldRuleRevision"("productType", "fieldKey");

-- CreateIndex
CREATE INDEX "MasterFieldRuleRevision_workspaceId_idx" ON "MasterFieldRuleRevision"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterFieldRuleRevision_productType_fieldKey_version_key" ON "MasterFieldRuleRevision"("workspaceId", "productType", "fieldKey", "version");

-- CreateIndex
CREATE INDEX "Workspace_status_createdAt_idx" ON "Workspace"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_createdByUserId_creationKey_key" ON "Workspace"("createdByUserId", "creationKey");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_userId_status_idx" ON "WorkspaceMembership"("userId", "status");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_profile_page_idx" ON "WorkspaceMembership"("userId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_key" ON "WorkspaceMembership"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "WorkspaceMemberRole_roleId_idx" ON "WorkspaceMemberRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceInvitation_workspaceId_email_idx" ON "WorkspaceInvitation"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "WorkspaceAudit_workspaceId_createdAt_idx" ON "WorkspaceAudit"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelAccountOwnership_workspaceId_idx" ON "ChannelAccountOwnership"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceMemberAccount_connectionId_idx" ON "WorkspaceMemberAccount"("connectionId");

-- CreateIndex
CREATE INDEX "ChannelListingClaim_workspaceId_idx" ON "ChannelListingClaim"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelListingClaim_channelListingId_idx" ON "ChannelListingClaim"("channelListingId");

-- CreateIndex
CREATE INDEX "ChannelAccountGrant_workspaceId_idx" ON "ChannelAccountGrant"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelAccountGrant_ownerWorkspaceId_idx" ON "ChannelAccountGrant"("ownerWorkspaceId");

-- CreateIndex
CREATE INDEX "Assortment_workspaceId_idx" ON "Assortment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Assortment_workspace_name_key" ON "Assortment"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Assortment_id_workspaceId_key" ON "Assortment"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "AssortmentMember_productId_idx" ON "AssortmentMember"("productId");

-- CreateIndex
CREATE INDEX "AssortmentMember_workspaceId_idx" ON "AssortmentMember"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssortmentMember_assortmentId_productId_key" ON "AssortmentMember"("workspaceId", "assortmentId", "productId");

-- CreateIndex
CREATE INDEX "AssortmentShare_ownerWorkspaceId_status_idx" ON "AssortmentShare"("ownerWorkspaceId", "status");

-- CreateIndex
CREATE INDEX "AssortmentShare_workspaceId_status_idx" ON "AssortmentShare"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AssortmentShare_assortmentId_idx" ON "AssortmentShare"("assortmentId");

-- CreateIndex
CREATE INDEX "CatalogLink_shareId_idx" ON "CatalogLink"("shareId");

-- CreateIndex
CREATE INDEX "CatalogLink_sourceWorkspaceId_sourceProductId_idx" ON "CatalogLink"("sourceWorkspaceId", "sourceProductId");

-- CreateIndex
CREATE INDEX "CatalogLink_targetWorkspaceId_targetProductId_idx" ON "CatalogLink"("targetWorkspaceId", "targetProductId");

-- CreateIndex
CREATE INDEX "AssortmentChange_targetWorkspaceId_state_availableAt_idx" ON "AssortmentChange"("targetWorkspaceId", "state", "availableAt");

-- CreateIndex
CREATE INDEX "AssortmentChange_linkId_idx" ON "AssortmentChange"("linkId");

-- CreateIndex
CREATE INDEX "AssortmentCopyRun_shareId_idx" ON "AssortmentCopyRun"("shareId");

-- CreateIndex
CREATE INDEX "AssortmentCopyRun_state_idx" ON "AssortmentCopyRun"("state");

-- CreateIndex
CREATE INDEX "AssortmentCopyRun_workspaceId_idx" ON "AssortmentCopyRun"("workspaceId");

-- CreateIndex
CREATE INDEX "StockPoolGrant_ownerWorkspaceId_status_idx" ON "StockPoolGrant"("ownerWorkspaceId", "status");

-- CreateIndex
CREATE INDEX "StockPoolGrant_workspaceId_status_idx" ON "StockPoolGrant"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "StockPoolLink_grantId_idx" ON "StockPoolLink"("grantId");

-- CreateIndex
CREATE INDEX "StockPoolLink_catalogLinkId_idx" ON "StockPoolLink"("catalogLinkId");

-- CreateIndex
CREATE INDEX "StockPoolLink_productId_idx" ON "StockPoolLink"("productId");

-- CreateIndex
CREATE INDEX "StockPoolLink_workspaceId_idx" ON "StockPoolLink"("workspaceId");

-- CreateIndex
CREATE INDEX "EtsyReceiptIngest_workspaceId_idx" ON "EtsyReceiptIngest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EtsyReceiptIngest_connectionId_key" ON "EtsyReceiptIngest"("workspaceId", "connectionId");

-- CreateIndex
CREATE INDEX "EtsyReceiptRefusal_connectionId_createdAt_idx" ON "EtsyReceiptRefusal"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "EtsyReceiptRefusal_workspaceId_idx" ON "EtsyReceiptRefusal"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EtsyReceiptRefusal_version_code_key" ON "EtsyReceiptRefusal"("workspaceId", "connectionId", "receiptId", "receiptVersion", "code");

-- CreateIndex
CREATE INDEX "StockPoolTask_workspaceId_claimedAt_createdAt_idx" ON "StockPoolTask"("workspaceId", "claimedAt", "createdAt");

-- CreateIndex
CREATE INDEX "StockPoolTask_productId_idx" ON "StockPoolTask"("productId");

-- CreateIndex
CREATE INDEX "ChannelAccountRoute_destinationIds_idx" ON "ChannelAccountRoute" USING GIN ("destinationIds");

-- CreateIndex
CREATE INDEX "ChannelAccountRoute_inboundAliases_idx" ON "ChannelAccountRoute" USING GIN ("inboundAliases");

-- CreateIndex
CREATE INDEX "ChannelAccountRoute_channelType_externalAccountId_idx" ON "ChannelAccountRoute"("channelType", "externalAccountId");

-- CreateIndex
CREATE INDEX "ChannelAccountRoute_workspaceId_idx" ON "ChannelAccountRoute"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelListingTranslation_channelListingId_idx" ON "ChannelListingTranslation"("channelListingId");

-- CreateIndex
CREATE INDEX "ChannelListingTranslation_workspaceId_idx" ON "ChannelListingTranslation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelListingTranslation_workspaceId_channelListingId_lang_key" ON "ChannelListingTranslation"("workspaceId", "channelListingId", "language");

-- CreateIndex
CREATE INDEX "ReadinessIndex_channel_market_language_state_idx" ON "ReadinessIndex"("channel", "market", "language", "state");

-- CreateIndex
CREATE INDEX "ReadinessIndex_productId_idx" ON "ReadinessIndex"("productId");

-- CreateIndex
CREATE INDEX "ReadinessIndex_workspaceId_idx" ON "ReadinessIndex"("workspaceId");

-- CreateIndex
CREATE INDEX "ReadinessIndex_workspaceId_pendingSince_idx" ON "ReadinessIndex"("workspaceId", "pendingSince");

-- CreateIndex
CREATE UNIQUE INDEX "ReadinessIndex_workspaceId_productId_coordinateKey_language_key" ON "ReadinessIndex"("workspaceId", "productId", "coordinateKey", "language");

-- CreateIndex
CREATE INDEX "ChannelDrift_workspaceId_idx" ON "ChannelDrift"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelDrift_driftCount_idx" ON "ChannelDrift"("driftCount");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelDrift_workspaceId_channelListingId_key" ON "ChannelDrift"("workspaceId", "channelListingId");

-- CreateIndex
CREATE INDEX "SellerReferenceLabel_workspaceId_idx" ON "SellerReferenceLabel"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerReferenceLabel_channel_connection_market_type_field_uq" ON "SellerReferenceLabel"("workspaceId", "channel", "connectionId", "marketplace", "productType", "fieldKey");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthClient_clientId_key" ON "OAuthClient"("clientId");

-- CreateIndex
CREATE INDEX "OAuthGrant_userId_idx" ON "OAuthGrant"("userId");

-- CreateIndex
CREATE INDEX "OAuthGrant_workspaceId_revokedAt_idx" ON "OAuthGrant"("workspaceId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthGrant_workspaceId_userId_clientId_key" ON "OAuthGrant"("workspaceId", "userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAuthorizationCode_codeHash_key" ON "OAuthAuthorizationCode"("codeHash");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_grantId_idx" ON "OAuthAuthorizationCode"("grantId");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_expiresAt_idx" ON "OAuthAuthorizationCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthToken_tokenHash_key" ON "OAuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OAuthToken_grantId_kind_idx" ON "OAuthToken"("grantId", "kind");

-- CreateIndex
CREATE INDEX "OAuthToken_expiresAt_idx" ON "OAuthToken"("expiresAt");

-- CreateIndex
CREATE INDEX "ShopifyColourProduct_workspaceId_idx" ON "ShopifyColourProduct"("workspaceId");

-- CreateIndex
CREATE INDEX "ShopifyColourProduct_familyId_idx" ON "ShopifyColourProduct"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyColourProduct_workspaceId_channelConnectionId_market_key" ON "ShopifyColourProduct"("workspaceId", "channelConnectionId", "marketplace", "aliasKey", "familyId", "valueKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyColourProduct_workspaceId_channelConnectionId_shopif_key" ON "ShopifyColourProduct"("workspaceId", "channelConnectionId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ShopifyColourSync_workspaceId_dueAt_idx" ON "ShopifyColourSync"("workspaceId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyColourSync_workspaceId_familyId_channelConnectionId__key" ON "ShopifyColourSync"("workspaceId", "familyId", "channelConnectionId", "marketplace", "aliasKey");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_workflowStageId_fkey" FOREIGN KEY ("workflowStageId") REFERENCES "WorkflowStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_masterProductId_fkey" FOREIGN KEY ("masterProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuAlias" ADD CONSTRAINT "SkuAlias_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFamily" ADD CONSTRAINT "ProductFamily_parentFamilyId_fkey" FOREIGN KEY ("parentFamilyId") REFERENCES "ProductFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFamily" ADD CONSTRAINT "ProductFamily_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ProductWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomAttribute" ADD CONSTRAINT "CustomAttribute_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AttributeGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeOption" ADD CONSTRAINT "AttributeOption_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "CustomAttribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyAttribute" ADD CONSTRAINT "FamilyAttribute_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyAttribute" ADD CONSTRAINT "FamilyAttribute_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "CustomAttribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStage" ADD CONSTRAINT "WorkflowStage_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ProductWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_fromStageId_fkey" FOREIGN KEY ("fromStageId") REFERENCES "WorkflowStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_toStageId_fkey" FOREIGN KEY ("toStageId") REFERENCES "WorkflowStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowComment" ADD CONSTRAINT "WorkflowComment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowComment" ADD CONSTRAINT "WorkflowComment_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "WorkflowStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAssignment" ADD CONSTRAINT "WorkflowAssignment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAssignment" ADD CONSTRAINT "WorkflowAssignment_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "WorkflowStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAssignment" ADD CONSTRAINT "WorkflowAssignment_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTierPrice" ADD CONSTRAINT "ProductTierPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTierPrice" ADD CONSTRAINT "ProductTierPrice_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "CustomerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalAsset" ADD CONSTRAINT "DigitalAsset_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "AssetFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetFolder" ADD CONSTRAINT "AssetFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AssetFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetUsage" ADD CONSTRAINT "AssetUsage_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "DigitalAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetUsage" ADD CONSTRAINT "AssetUsage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepricingRule" ADD CONSTRAINT "RepricingRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepricingDecision" ADD CONSTRAINT "RepricingDecision_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RepricingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariation" ADD CONSTRAINT "ProductVariation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantImage" ADD CONSTRAINT "VariantImage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantChannelListing" ADD CONSTRAINT "VariantChannelListing_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantChannelListing" ADD CONSTRAINT "VariantChannelListing_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_aliasId_fkey" FOREIGN KEY ("aliasId") REFERENCES "ProductListingAlias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductListingAlias" ADD CONSTRAINT "ProductListingAlias_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductListingAlias" ADD CONSTRAINT "ProductListingAlias_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingSnapshot" ADD CONSTRAINT "ChannelListingSnapshot_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingOverride" ADD CONSTRAINT "ChannelListingOverride_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldLinkGroup" ADD CONSTRAINT "FieldLinkGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncAttempt" ADD CONSTRAINT "SyncAttempt_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmazonSuppression" ADD CONSTRAINT "AmazonSuppression_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingIssue" ADD CONSTRAINT "ListingIssue_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingRecoveryEvent" ADD CONSTRAINT "ListingRecoveryEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingImage" ADD CONSTRAINT "ChannelListingImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingImage" ADD CONSTRAINT "ChannelListingImage_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_derivedFromImageId_fkey" FOREIGN KEY ("derivedFromImageId") REFERENCES "ProductImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_sameAsImageId_fkey" FOREIGN KEY ("sameAsImageId") REFERENCES "ProductImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMediaPlan" ADD CONSTRAINT "ProductMediaPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceSync" ADD CONSTRAINT "MarketplaceSync_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftListing" ADD CONSTRAINT "DraftListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLog" ADD CONSTRAINT "StockLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FBAShipmentItem" ADD CONSTRAINT "FBAShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "FBAShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FBAShipmentItem" ADD CONSTRAINT "FBAShipmentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleProduct" ADD CONSTRAINT "PricingRuleProduct_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PricingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleProduct" ADD CONSTRAINT "PricingRuleProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleVariation" ADD CONSTRAINT "PricingRuleVariation_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PricingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleVariation" ADD CONSTRAINT "PricingRuleVariation_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncHealthLog" ADD CONSTRAINT "SyncHealthLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncHealthLog" ADD CONSTRAINT "SyncHealthLog_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkActionItem" ADD CONSTRAINT "BulkActionItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkActionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdGroup" ADD CONSTRAINT "AdGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdTarget" ADD CONSTRAINT "AdTarget_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "AdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProductAd" ADD CONSTRAINT "AdProductAd_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "AdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProductAd" ADD CONSTRAINT "AdProductAd_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordWatchlistTerm" ADD CONSTRAINT "KeywordWatchlistTerm_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "KeywordWatchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordCoverageTerm" ADD CONSTRAINT "KeywordCoverageTerm_setId_fkey" FOREIGN KEY ("setId") REFERENCES "KeywordCoverageSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaStorageAge" ADD CONSTRAINT "FbaStorageAge_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductProfitDaily" ADD CONSTRAINT "ProductProfitDaily_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetPoolAllocation" ADD CONSTRAINT "BudgetPoolAllocation_budgetPoolId_fkey" FOREIGN KEY ("budgetPoolId") REFERENCES "BudgetPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetPoolRebalance" ADD CONSTRAINT "BudgetPoolRebalance_budgetPoolId_fkey" FOREIGN KEY ("budgetPoolId") REFERENCES "BudgetPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBidHistory" ADD CONSTRAINT "CampaignBidHistory_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSettings" ADD CONSTRAINT "AccountSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationWebhook" ADD CONSTRAINT "NotificationWebhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataExportRequest" ADD CONSTRAINT "DataExportRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorRecoveryCode" ADD CONSTRAINT "TwoFactorRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayNoticeQuarantine" ADD CONSTRAINT "EbayNoticeQuarantine_resolvedReceiptId_fkey" FOREIGN KEY ("resolvedReceiptId") REFERENCES "WebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErasureRequest" ADD CONSTRAINT "ErasureRequest_quarantineId_fkey" FOREIGN KEY ("quarantineId") REFERENCES "EbayNoticeQuarantine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErasureRequest" ADD CONSTRAINT "ErasureRequest_evidenceOrderId_fkey" FOREIGN KEY ("evidenceOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelLiveImage" ADD CONSTRAINT "ChannelLiveImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelStockEvent" ADD CONSTRAINT "ChannelStockEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalInvoice" ADD CONSTRAINT "FiscalInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "FiscalInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNote" ADD CONSTRAINT "OrderNote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRiskScore" ADD CONSTRAINT "OrderRiskScore_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceChangeEvent" ADD CONSTRAINT "PriceChangeEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyBoxHistory" ADD CONSTRAINT "BuyBoxHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetailEventPriceAction" ADD CONSTRAINT "RetailEventPriceAction_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "RetailEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionScope" ADD CONSTRAINT "ConnectionScope_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionEvent" ADD CONSTRAINT "ConnectionEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundSyncQueue" ADD CONSTRAINT "OutboundSyncQueue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundSyncQueue" ADD CONSTRAINT "OutboundSyncQueue_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJobRow" ADD CONSTRAINT "ImportJobRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceTaxonomySnapshot" ADD CONSTRAINT "MarketplaceTaxonomySnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MarketplaceTaxonomy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceTaxonomyNode" ADD CONSTRAINT "MarketplaceTaxonomyNode_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MarketplaceTaxonomySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingWizard" ADD CONSTRAINT "ListingWizard_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledImagePublish" ADD CONSTRAINT "ScheduledImagePublish_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledWizardPublish" ADD CONSTRAINT "ScheduledWizardPublish_wizardId_fkey" FOREIGN KEY ("wizardId") REFERENCES "ListingWizard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WizardStepEvent" ADD CONSTRAINT "WizardStepEvent_wizardId_fkey" FOREIGN KEY ("wizardId") REFERENCES "ListingWizard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WizardStepEvent" ADD CONSTRAINT "WizardStepEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APlusContent" ADD CONSTRAINT "APlusContent_masterContentId_fkey" FOREIGN KEY ("masterContentId") REFERENCES "APlusContent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APlusContentVersion" ADD CONSTRAINT "APlusContentVersion_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "APlusContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APlusContentAsin" ADD CONSTRAINT "APlusContentAsin_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "APlusContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APlusContentAsin" ADD CONSTRAINT "APlusContentAsin_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APlusModule" ADD CONSTRAINT "APlusModule_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "APlusContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandStory" ADD CONSTRAINT "BrandStory_masterStoryId_fkey" FOREIGN KEY ("masterStoryId") REFERENCES "BrandStory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandStoryModule" ADD CONSTRAINT "BrandStoryModule_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "BrandStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandStoryVersion" ADD CONSTRAINT "BrandStoryVersion_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "BrandStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandWatermarkTemplate" ADD CONSTRAINT "BrandWatermarkTemplate_workspaceId_brand_fkey" FOREIGN KEY ("workspaceId", "brand") REFERENCES "BrandKit"("workspaceId", "brand") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocaleOverlay" ADD CONSTRAINT "AssetLocaleOverlay_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "DigitalAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingImage" ADD CONSTRAINT "ListingImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingImage" ADD CONSTRAINT "ListingImage_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmazonImageFeedJob" ADD CONSTRAINT "AmazonImageFeedJob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelImagePublishJob" ADD CONSTRAINT "ChannelImagePublishJob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_defaultCarrierAccountId_fkey" FOREIGN KEY ("defaultCarrierAccountId") REFERENCES "CarrierAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_stockLevelId_fkey" FOREIGN KEY ("stockLevelId") REFERENCES "StockLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_serialNumberId_fkey" FOREIGN KEY ("serialNumberId") REFERENCES "SerialNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_binId_fkey" FOREIGN KEY ("binId") REFERENCES "StockBin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCostLayer" ADD CONSTRAINT "StockCostLayer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCostLayer" ADD CONSTRAINT "StockCostLayer_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCostLayer" ADD CONSTRAINT "StockCostLayer_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_originStockMovementId_fkey" FOREIGN KEY ("originStockMovementId") REFERENCES "StockMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBin" ADD CONSTRAINT "StockBin_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBinQuantity" ADD CONSTRAINT "StockBinQuantity_stockLevelId_fkey" FOREIGN KEY ("stockLevelId") REFERENCES "StockLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBinQuantity" ADD CONSTRAINT "StockBinQuantity_binId_fkey" FOREIGN KEY ("binId") REFERENCES "StockBin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotRecall" ADD CONSTRAINT "LotRecall_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaInventoryDetail" ADD CONSTRAINT "FbaInventoryDetail_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCFShipment" ADD CONSTRAINT "MCFShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierService" ADD CONSTRAINT "CarrierService_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierServiceMapping" ADD CONSTRAINT "CarrierServiceMapping_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierServiceMapping" ADD CONSTRAINT "CarrierServiceMapping_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "CarrierService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierMetric" ADD CONSTRAINT "CarrierMetric_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupSchedule" ADD CONSTRAINT "PickupSchedule_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierAccount" ADD CONSTRAINT "CarrierAccount_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingMessageLog" ADD CONSTRAINT "TrackingMessageLog_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierShippingProfile" ADD CONSTRAINT "SupplierShippingProfile_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_developmentProjectId_fkey" FOREIGN KEY ("developmentProjectId") REFERENCES "DevelopmentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderAttachment" ADD CONSTRAINT "PurchaseOrderAttachment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderRevision" ADD CONSTRAINT "PurchaseOrderRevision_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoComment" ADD CONSTRAINT "PoComment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoTemplate" ADD CONSTRAINT "PoTemplate_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoTemplate" ADD CONSTRAINT "PoTemplate_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoTemplateItem" ADD CONSTRAINT "PoTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PoTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoSchedule" ADD CONSTRAINT "PoSchedule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PoTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundShipment" ADD CONSTRAINT "InboundShipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundShipment" ADD CONSTRAINT "InboundShipment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundShipment" ADD CONSTRAINT "InboundShipment_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundShipmentAttachment" ADD CONSTRAINT "InboundShipmentAttachment_inboundShipmentId_fkey" FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundDiscrepancy" ADD CONSTRAINT "InboundDiscrepancy_inboundShipmentId_fkey" FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundDiscrepancy" ADD CONSTRAINT "InboundDiscrepancy_inboundShipmentItemId_fkey" FOREIGN KEY ("inboundShipmentItemId") REFERENCES "InboundShipmentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundShipmentItem" ADD CONSTRAINT "InboundShipmentItem_inboundShipmentId_fkey" FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundShipmentItem" ADD CONSTRAINT "InboundShipmentItem_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_inboundShipmentItemId_fkey" FOREIGN KEY ("inboundShipmentItemId") REFERENCES "InboundShipmentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundAttempt" ADD CONSTRAINT "RefundAttempt_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCount" ADD CONSTRAINT "CycleCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountItem" ADD CONSTRAINT "CycleCountItem_cycleCountId_fkey" FOREIGN KEY ("cycleCountId") REFERENCES "CycleCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRoutingRule" ADD CONSTRAINT "OrderRoutingRule_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSubstitution" ADD CONSTRAINT "ProductSubstitution_primaryProductId_fkey" FOREIGN KEY ("primaryProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSubstitution" ADD CONSTRAINT "ProductSubstitution_substituteProductId_fkey" FOREIGN KEY ("substituteProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockoutEvent" ADD CONSTRAINT "StockoutEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockoutEvent" ADD CONSTRAINT "StockoutEvent_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaRestockRow" ADD CONSTRAINT "FbaRestockRow_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "FbaRestockReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaInboundPlanV2" ADD CONSTRAINT "FbaInboundPlanV2_inboundShipmentId_fkey" FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTag" ADD CONSTRAINT "AssetTag_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "DigitalAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTag" ADD CONSTRAINT "AssetTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTag" ADD CONSTRAINT "ProductTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_attributedRequestId_fkey" FOREIGN KEY ("attributedRequestId") REFERENCES "ReviewRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_attributedRuleId_fkey" FOREIGN KEY ("attributedRuleId") REFERENCES "ReviewRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSentiment" ADD CONSTRAINT "ReviewSentiment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSpike" ADD CONSTRAINT "ReviewSpike_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmazonReviewInsight" ADD CONSTRAINT "AmazonReviewInsight_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ReviewRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSentimentCheck" ADD CONSTRAINT "ReviewSentimentCheck_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSentimentCheck" ADD CONSTRAINT "ReviewSentimentCheck_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ReviewRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSentimentCheck" ADD CONSTRAINT "ReviewSentimentCheck_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "ReviewRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTag" ADD CONSTRAINT "OrderTag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTag" ADD CONSTRAINT "OrderTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedViewAlert" ADD CONSTRAINT "SavedViewAlert_savedViewId_fkey" FOREIGN KEY ("savedViewId") REFERENCES "SavedView"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTranslation" ADD CONSTRAINT "ProductTranslation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_fromProductId_fkey" FOREIGN KEY ("fromProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_toProductId_fkey" FOREIGN KEY ("toProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSeo" ADD CONSTRAINT "ProductSeo_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCertificate" ADD CONSTRAINT "ProductCertificate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelPublishAttempt" ADD CONSTRAINT "ChannelPublishAttempt_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayCampaign" ADD CONSTRAINT "EbayCampaign_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayRateDiscoveryPlan" ADD CONSTRAINT "EbayRateDiscoveryPlan_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayCampaignAutomationPolicy" ADD CONSTRAINT "EbayCampaignAutomationPolicy_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAdGroup" ADD CONSTRAINT "EbayAdGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAd" ADD CONSTRAINT "EbayAd_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAd" ADD CONSTRAINT "EbayAd_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "EbayAdGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayKeyword" ADD CONSTRAINT "EbayKeyword_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayKeyword" ADD CONSTRAINT "EbayKeyword_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "EbayAdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayNegativeKeyword" ADD CONSTRAINT "EbayNegativeKeyword_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAdsRuleVersion" ADD CONSTRAINT "EbayAdsRuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "EbayAdsRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAdsRuleExecution" ADD CONSTRAINT "EbayAdsRuleExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "EbayAdsRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayWatcherStats" ADD CONSTRAINT "EbayWatcherStats_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayMarkdown" ADD CONSTRAINT "EbayMarkdown_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledProductChange" ADD CONSTRAINT "ScheduledProductChange_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRuleAssignment" ADD CONSTRAINT "CampaignRuleAssignment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRuleAssignment" ADD CONSTRAINT "CampaignRuleAssignment_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRuleExecution" ADD CONSTRAINT "AutomationRuleExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioRun" ADD CONSTRAINT "ScenarioRun_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogOrganizeChange" ADD CONSTRAINT "CatalogOrganizeChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CatalogOrganizeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryClosure" ADD CONSTRAINT "CategoryClosure_ancestorId_fkey" FOREIGN KEY ("ancestorId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryClosure" ADD CONSTRAINT "CategoryClosure_descendantId_fkey" FOREIGN KEY ("descendantId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingQualitySnapshot" ADD CONSTRAINT "ListingQualitySnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingDecision" ADD CONSTRAINT "RoutingDecision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaignLink" ADD CONSTRAINT "MarketingCampaignLink_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmazonAdsCampaignDetail" ADD CONSTRAINT "AmazonAdsCampaignDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayPromotedDetail" ADD CONSTRAINT "EbayPromotedDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountDetail" ADD CONSTRAINT "DiscountDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAdsDetail" ADD CONSTRAINT "ExternalAdsDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPushDetail" ADD CONSTRAINT "ContentPushDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDetail" ADD CONSTRAINT "OutreachDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBudgetAllocation" ADD CONSTRAINT "CampaignBudgetAllocation_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "CampaignBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBudgetAllocation" ADD CONSTRAINT "CampaignBudgetAllocation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBudgetRebalance" ADD CONSTRAINT "CampaignBudgetRebalance_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "CampaignBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMetric" ADD CONSTRAINT "CampaignMetric_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAction" ADD CONSTRAINT "CampaignAction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSchedule" ADD CONSTRAINT "AdSchedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RankScheduleGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankScheduleEvent" ADD CONSTRAINT "RankScheduleEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RankScheduleGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankScheduleVersion" ADD CONSTRAINT "RankScheduleVersion_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RankScheduleGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutopilotDecision" ADD CONSTRAINT "AutopilotDecision_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AutopilotPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierComm" ADD CONSTRAINT "SupplierComm_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierFollowUp" ADD CONSTRAINT "SupplierFollowUp_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentProjectSupplier" ADD CONSTRAINT "DevelopmentProjectSupplier_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DevelopmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentProjectSupplier" ADD CONSTRAINT "DevelopmentProjectSupplier_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentAttachment" ADD CONSTRAINT "DevelopmentAttachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DevelopmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentCertification" ADD CONSTRAINT "DevelopmentCertification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DevelopmentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedListingMembership" ADD CONSTRAINT "SharedListingMembership_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncChannelPolicy" ADD CONSTRAINT "SyncChannelPolicy_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMappingField" ADD CONSTRAINT "ChannelMappingField_setId_fkey" FOREIGN KEY ("setId") REFERENCES "ChannelMappingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMappingUse" ADD CONSTRAINT "ChannelMappingUse_setId_fkey" FOREIGN KEY ("setId") REFERENCES "ChannelMappingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedReportVersion" ADD CONSTRAINT "SavedReportVersion_savedReportId_fkey" FOREIGN KEY ("savedReportId") REFERENCES "SavedReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_savedReportId_fkey" FOREIGN KEY ("savedReportId") REFERENCES "SavedReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsConsoleRow" ADD CONSTRAINT "AdsConsoleRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "AdsConsoleImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryChannelMapping" ADD CONSTRAINT "CategoryChannelMapping_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellFormula" ADD CONSTRAINT "CellFormula_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberRole" ADD CONSTRAINT "WorkspaceMemberRole_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberRole" ADD CONSTRAINT "WorkspaceMemberRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAudit" ADD CONSTRAINT "WorkspaceAudit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccountOwnership" ADD CONSTRAINT "ChannelAccountOwnership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberAccountLimit" ADD CONSTRAINT "WorkspaceMemberAccountLimit_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberAccount" ADD CONSTRAINT "WorkspaceMemberAccount_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberAccount" ADD CONSTRAINT "WorkspaceMemberAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingClaim" ADD CONSTRAINT "ChannelListingClaim_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingClaim" ADD CONSTRAINT "ChannelListingClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingClaim" ADD CONSTRAINT "ChannelListingClaim_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccountGrant" ADD CONSTRAINT "ChannelAccountGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccountGrant" ADD CONSTRAINT "ChannelAccountGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccountGrant" ADD CONSTRAINT "ChannelAccountGrant_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentMember" ADD CONSTRAINT "AssortmentMember_assortmentId_fkey" FOREIGN KEY ("assortmentId") REFERENCES "Assortment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentMember" ADD CONSTRAINT "AssortmentMember_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_assortmentId_ownerWorkspaceId_fkey" FOREIGN KEY ("assortmentId", "ownerWorkspaceId") REFERENCES "Assortment"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentShare" ADD CONSTRAINT "AssortmentShare_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogLink" ADD CONSTRAINT "CatalogLink_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "AssortmentShare"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogLink" ADD CONSTRAINT "CatalogLink_sourceWorkspaceId_fkey" FOREIGN KEY ("sourceWorkspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogLink" ADD CONSTRAINT "CatalogLink_targetWorkspaceId_fkey" FOREIGN KEY ("targetWorkspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentChange" ADD CONSTRAINT "AssortmentChange_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "CatalogLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssortmentCopyRun" ADD CONSTRAINT "AssortmentCopyRun_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "AssortmentShare"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPoolGrant" ADD CONSTRAINT "StockPoolGrant_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPoolGrant" ADD CONSTRAINT "StockPoolGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPoolLink" ADD CONSTRAINT "StockPoolLink_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "StockPoolGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPoolLink" ADD CONSTRAINT "StockPoolLink_catalogLinkId_fkey" FOREIGN KEY ("catalogLinkId") REFERENCES "CatalogLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPoolLink" ADD CONSTRAINT "StockPoolLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtsyReceiptIngest" ADD CONSTRAINT "EtsyReceiptIngest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtsyReceiptRefusal" ADD CONSTRAINT "EtsyReceiptRefusal_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPoolTask" ADD CONSTRAINT "StockPoolTask_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccountRoute" ADD CONSTRAINT "ChannelAccountRoute_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccountRoute" ADD CONSTRAINT "ChannelAccountRoute_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelListingTranslation" ADD CONSTRAINT "ChannelListingTranslation_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadinessIndex" ADD CONSTRAINT "ReadinessIndex_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelDrift" ADD CONSTRAINT "ChannelDrift_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OAuthGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OAuthGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyColourProduct" ADD CONSTRAINT "ShopifyColourProduct_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyColourProduct" ADD CONSTRAINT "ShopifyColourProduct_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyColourSync" ADD CONSTRAINT "ShopifyColourSync_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyColourSync" ADD CONSTRAINT "ShopifyColourSync_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

