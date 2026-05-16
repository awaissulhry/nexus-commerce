-- AD.5 — Cross-marketplace budget pools (intra-Amazon).
-- Cross-channel (Meta / Google) deferred to Pillar 2.5.

CREATE TABLE IF NOT EXISTS "BudgetPool" (
  "id" TEXT PRIMARY KEY,
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
  "createdBy" TEXT
);

CREATE INDEX IF NOT EXISTS "BudgetPool_enabled_lastRebalancedAt_idx"
  ON "BudgetPool" ("enabled", "lastRebalancedAt");

CREATE TABLE IF NOT EXISTS "BudgetPoolAllocation" (
  "id" TEXT PRIMARY KEY,
  "budgetPoolId" TEXT NOT NULL REFERENCES "BudgetPool"("id") ON DELETE CASCADE,
  "marketplace" TEXT NOT NULL,
  "campaignId" TEXT,
  "targetSharePct" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  "minDailyBudgetCents" INTEGER NOT NULL DEFAULT 100,
  "maxDailyBudgetCents" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "BudgetPoolAllocation_budgetPoolId_marketplace_campaignId_key"
  ON "BudgetPoolAllocation" ("budgetPoolId", "marketplace", "campaignId");
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetPoolAllocation_campaignId_key"
  ON "BudgetPoolAllocation" ("campaignId");
CREATE INDEX IF NOT EXISTS "BudgetPoolAllocation_budgetPoolId_idx"
  ON "BudgetPoolAllocation" ("budgetPoolId");
CREATE INDEX IF NOT EXISTS "BudgetPoolAllocation_marketplace_idx"
  ON "BudgetPoolAllocation" ("marketplace");

CREATE TABLE IF NOT EXISTS "BudgetPoolRebalance" (
  "id" TEXT PRIMARY KEY,
  "budgetPoolId" TEXT NOT NULL REFERENCES "BudgetPool"("id") ON DELETE CASCADE,
  "triggeredBy" TEXT NOT NULL,
  "inputs" JSONB NOT NULL,
  "outputs" JSONB NOT NULL,
  "dryRun" BOOLEAN NOT NULL,
  "appliedAt" TIMESTAMP(3),
  "totalShiftCents" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "BudgetPoolRebalance_budgetPoolId_createdAt_idx"
  ON "BudgetPoolRebalance" ("budgetPoolId", "createdAt" DESC);
