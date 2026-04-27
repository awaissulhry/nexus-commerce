-- Phase 20: SSOT (Single Source of Truth) Architecture
-- Adds SSOT indicators to Product model
-- ChannelListing SSOT fields are defined in schema.prisma and will be created when the table is first created

-- ── PHASE 20: Extend Product with SSOT Indicators ────────────────────────────
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "productType" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "categoryAttributes" JSONB;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "isMasterProduct" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "masterProductId" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "syncChannels" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "validationStatus" TEXT NOT NULL DEFAULT 'VALID';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "validationErrors" TEXT[];
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "hasChannelOverrides" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "lastChannelOverrideAt" TIMESTAMP(3);
