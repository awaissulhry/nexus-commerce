-- AX.9 — Dayparting: AdSchedule (additive, online-safe).
-- CreateTable
CREATE TABLE "AdSchedule" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastApplied" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AdSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdSchedule_campaignId_idx" ON "AdSchedule"("campaignId");

-- CreateIndex
CREATE INDEX "AdSchedule_enabled_idx" ON "AdSchedule"("enabled");

