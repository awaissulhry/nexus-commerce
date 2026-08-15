-- BID.S5 -- bid bounds at MARKET/PORTFOLIO/LINE grain. Purely additive: one table, two indexes.
-- The CAMPAIGN grain stays the existing Campaign.minBidCents/maxBidCents columns, which override
-- anything here; the gate resolves campaign ?? LINE ?? PORTFOLIO ?? MARKET per side. Inert until
-- a row exists (zero exist as this ships).
CREATE TABLE "AdBidPolicy" (
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
CREATE UNIQUE INDEX "AdBidPolicy_grain_scopeId_key" ON "AdBidPolicy"("grain", "scopeId");
CREATE INDEX "AdBidPolicy_enabled_idx" ON "AdBidPolicy"("enabled");
