-- ER1 — per-campaign automation governance (posture / protected / caps).
-- Reversible: DROP TABLE "EbayCampaignAutomationPolicy";

CREATE TABLE "EbayCampaignAutomationPolicy" (
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

CREATE UNIQUE INDEX "EbayCampaignAutomationPolicy_campaignId_key" ON "EbayCampaignAutomationPolicy"("campaignId");

ALTER TABLE "EbayCampaignAutomationPolicy" ADD CONSTRAINT "EbayCampaignAutomationPolicy_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
