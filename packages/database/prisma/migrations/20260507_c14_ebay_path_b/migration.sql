-- C.14 — eBay Path B schema. Adds three tables that back the C.15
-- (KPI strip), C.16 (Promoted Listings campaign manager), and C.17
-- (Markdown manager) feature surfaces.
--
-- Pure additive — no modifications to existing tables, no enum
-- changes. Cascade FKs so deleting a ChannelConnection sweeps its
-- campaigns; deleting a ChannelListing sweeps its watcher stats and
-- markdowns. The audit trail for ENDED/CANCELLED markdowns lives on
-- the surviving rows; if a listing itself is gone, the markdown
-- history goes with it (operationally fine — markdowns target
-- specific listings, can't outlive them).

-- ── EbayCampaign — Promoted Listings campaigns ────────────────────────
CREATE TABLE "EbayCampaign" (
    "id" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "externalCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fundingStrategy" TEXT NOT NULL,
    "bidPercentage" DECIMAL(6,2),
    "dailyBudget" DECIMAL(10,2),
    "budgetCurrency" TEXT,
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

CREATE UNIQUE INDEX "EbayCampaign_channelConnectionId_externalCampaignId_key"
    ON "EbayCampaign"("channelConnectionId", "externalCampaignId");

CREATE INDEX "EbayCampaign_channelConnectionId_status_idx"
    ON "EbayCampaign"("channelConnectionId", "status");

CREATE INDEX "EbayCampaign_marketplace_status_idx"
    ON "EbayCampaign"("marketplace", "status");

ALTER TABLE "EbayCampaign" ADD CONSTRAINT "EbayCampaign_channelConnectionId_fkey"
    FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── EbayWatcherStats — per-listing engagement snapshots ───────────────
CREATE TABLE "EbayWatcherStats" (
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "watcherCount" INTEGER NOT NULL DEFAULT 0,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayWatcherStats_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EbayWatcherStats_channelListingId_snapshotAt_idx"
    ON "EbayWatcherStats"("channelListingId", "snapshotAt");

ALTER TABLE "EbayWatcherStats" ADD CONSTRAINT "EbayWatcherStats_channelListingId_fkey"
    FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── EbayMarkdown — sale events on individual listings ─────────────────
CREATE TABLE "EbayMarkdown" (
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

CREATE INDEX "EbayMarkdown_channelListingId_startDate_idx"
    ON "EbayMarkdown"("channelListingId", "startDate");

CREATE INDEX "EbayMarkdown_status_endDate_idx"
    ON "EbayMarkdown"("status", "endDate");

ALTER TABLE "EbayMarkdown" ADD CONSTRAINT "EbayMarkdown_channelListingId_fkey"
    FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
