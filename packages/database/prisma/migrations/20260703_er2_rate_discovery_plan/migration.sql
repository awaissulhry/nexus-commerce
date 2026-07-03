-- ER2 — Rate Discovery plans (bounded, break-even-anchored rate ladder).
-- Reversible: DROP TABLE "EbayRateDiscoveryPlan";

CREATE TABLE "EbayRateDiscoveryPlan" (
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

CREATE UNIQUE INDEX "EbayRateDiscoveryPlan_campaignId_key" ON "EbayRateDiscoveryPlan"("campaignId");
CREATE INDEX "EbayRateDiscoveryPlan_status_idx" ON "EbayRateDiscoveryPlan"("status");

ALTER TABLE "EbayRateDiscoveryPlan" ADD CONSTRAINT "EbayRateDiscoveryPlan_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
