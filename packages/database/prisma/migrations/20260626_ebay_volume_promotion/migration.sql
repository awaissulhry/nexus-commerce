-- VP.1: eBay Volume Pricing promotion (multi-buy tiers) — promotion-centric,
-- maps to eBay's createItemPromotion volume pricing. Sibling of EbayMarkdown.

CREATE TABLE "EbayVolumePromotion" (
    "id"                  TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "marketplace"         TEXT NOT NULL,
    "tiers"               JSONB NOT NULL,
    "skus"                JSONB,
    "status"              TEXT NOT NULL DEFAULT 'DRAFT',
    "startDate"           TIMESTAMP(3),
    "endDate"             TIMESTAMP(3),
    "externalPromotionId" TEXT,
    "lastSyncedAt"        TIMESTAMP(3),
    "lastSyncStatus"      TEXT,
    "lastSyncError"       TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EbayVolumePromotion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EbayVolumePromotion_marketplace_status_idx" ON "EbayVolumePromotion"("marketplace", "status");
