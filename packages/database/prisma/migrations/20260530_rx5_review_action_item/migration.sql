-- RX.5 — Persisted, actionable spike-driven fixes (close the SR.3 loop).
-- Additive: one new table, no changes to existing tables.

-- CreateTable
CREATE TABLE "ReviewActionItem" (
    "id" TEXT NOT NULL,
    "spikeId" TEXT,
    "productId" TEXT,
    "marketplace" TEXT,
    "category" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewActionItem_status_createdAt_idx" ON "ReviewActionItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewActionItem_spikeId_idx" ON "ReviewActionItem"("spikeId");

-- CreateIndex
CREATE INDEX "ReviewActionItem_productId_idx" ON "ReviewActionItem"("productId");
