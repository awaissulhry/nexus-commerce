-- AX3.10 — Budget Manager: AdBudgetPlan (additive, online-safe).
CREATE TABLE "AdBudgetPlan" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "tag" TEXT,
    "month" TEXT NOT NULL,
    "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "autoPacing" BOOLEAN NOT NULL DEFAULT false,
    "stopOverSpend" BOOLEAN NOT NULL DEFAULT false,
    "calendar" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AdBudgetPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdBudgetPlan_month_marketplace_idx" ON "AdBudgetPlan"("month", "marketplace");
