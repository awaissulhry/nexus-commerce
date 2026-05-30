-- CD.11 — Amazon Ads hourly performance store (Marketing Stream grain).
-- Additive, online-safe: brand-new table, no locks on existing tables.
-- Mirrors AmazonAdsDailyPerformance but keyed additionally by `hour` (0-23,
-- UTC) so dayparting + hourly share-of-voice become possible.

-- CreateTable
CREATE TABLE "AmazonAdsHourlyPerformance" (
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

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsHourlyPerformance_entity_date_hour_key" ON "AmazonAdsHourlyPerformance"("profileId", "adProduct", "entityType", "entityId", "date", "hour");

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyPerformance_localEntityId_date_idx" ON "AmazonAdsHourlyPerformance"("localEntityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyPerformance_mkt_date_hour_idx" ON "AmazonAdsHourlyPerformance"("marketplace", "date", "hour", "adProduct");
