-- ACR.3 — KeywordCoverageSet: the curated per-family keyword intent the coverage engine reads.
-- Additive; nothing consumes these tables until the pilot engine ships.
CREATE TABLE "KeywordCoverageSet" (
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
CREATE UNIQUE INDEX "KeywordCoverageSet_portfolioId_marketplace_name_key" ON "KeywordCoverageSet"("portfolioId", "marketplace", "name");
CREATE INDEX "KeywordCoverageSet_portfolioId_idx" ON "KeywordCoverageSet"("portfolioId");

CREATE TABLE "KeywordCoverageTerm" (
  "id" TEXT NOT NULL,
  "setId" TEXT NOT NULL,
  "term" TEXT NOT NULL,
  "leadAsin" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "maxCpcCents" INTEGER,
  "targetSharePct" DECIMAL(6,2),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KeywordCoverageTerm_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KeywordCoverageTerm_setId_fkey" FOREIGN KEY ("setId") REFERENCES "KeywordCoverageSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "KeywordCoverageTerm_setId_term_key" ON "KeywordCoverageTerm"("setId", "term");
CREATE INDEX "KeywordCoverageTerm_setId_status_idx" ON "KeywordCoverageTerm"("setId", "status");
