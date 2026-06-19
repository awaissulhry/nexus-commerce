-- AG.1 — AI Advertising "Product Goal" table. Additive + empty on deploy; non-destructive.
CREATE TABLE IF NOT EXISTS "AdProductGoal" (
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
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdProductGoal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdProductGoal_status_createdAt_idx" ON "AdProductGoal"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "AdProductGoal_marketplace_idx" ON "AdProductGoal"("marketplace");
