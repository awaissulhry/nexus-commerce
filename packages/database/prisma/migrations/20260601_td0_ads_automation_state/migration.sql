-- TD.0 — Trading Desk automation safety spine: runtime autonomy dial + circuit-breaker halt.
CREATE TABLE "AdsAutomationState" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "autonomy" TEXT NOT NULL DEFAULT 'AUTO',
  "halted" BOOLEAN NOT NULL DEFAULT false,
  "haltedAt" TIMESTAMP(3),
  "haltReason" TEXT,
  "haltedBy" TEXT,
  "maxHourlySpendCentsEur" INTEGER,
  "maxActionsPerHour" INTEGER,
  "lastCheckedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsAutomationState_pkey" PRIMARY KEY ("id")
);
