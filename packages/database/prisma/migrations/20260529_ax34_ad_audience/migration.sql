-- AX3.4 — AMC-style audiences: AdAudience (additive, online-safe).
-- CreateTable
CREATE TABLE "AdAudience" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audienceType" TEXT NOT NULL,
    "marketplace" TEXT,
    "lookbackDays" INTEGER NOT NULL DEFAULT 30,
    "asins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "params" JSONB NOT NULL DEFAULT '{}',
    "estimatedReach" INTEGER,
    "reachBasis" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "externalAudienceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AdAudience_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdAudience_status_idx" ON "AdAudience"("status");

-- CreateIndex
CREATE INDEX "AdAudience_audienceType_idx" ON "AdAudience"("audienceType");
