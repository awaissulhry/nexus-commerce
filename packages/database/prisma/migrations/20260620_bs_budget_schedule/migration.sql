-- BS — Budget Schedule (Helium 10 "Budget Schedules"). Hourly/daily budget-adjustment schedule.
-- CreateTable
CREATE TABLE "BudgetSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BUDGET',
    "type" TEXT NOT NULL DEFAULT 'CAMPAIGN_BUDGET',
    "campaigns" JSONB NOT NULL DEFAULT '[]',
    "windows" JSONB NOT NULL DEFAULT '[]',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "chartPrefs" JSONB NOT NULL DEFAULT '{}',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "neverExpire" BOOLEAN NOT NULL DEFAULT true,
    "excludeDates" JSONB NOT NULL DEFAULT '[]',
    "autoRefill" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastApplied" JSONB,
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "BudgetSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetSchedule_enabled_idx" ON "BudgetSchedule"("enabled");

-- CreateIndex
CREATE INDEX "BudgetSchedule_kind_idx" ON "BudgetSchedule"("kind");
