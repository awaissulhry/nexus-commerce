-- PES.8 — AI enrichment drafts.
-- Additive only: one new table, no change to any existing table, no foreign key.
-- The FK to Product is deliberately absent: Product belongs to PES.5's lane in
-- the shared tree and a Prisma relation needs a back-reference line on it.
-- Orphan rows are swept by the draft service, not cascaded by the database.

-- CreateTable
CREATE TABLE "ProductAiDraft" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cellKey" TEXT NOT NULL,
    "channel" TEXT,
    "marketplace" TEXT,
    "aliasLabel" TEXT,
    "locale" TEXT,
    "writeField" TEXT NOT NULL,
    "columnKey" TEXT NOT NULL,
    "draftValue" JSONB NOT NULL,
    "baseValue" JSONB,
    "baseSource" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confidence" TEXT,
    "rationale" TEXT,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "capsUsed" JSONB,
    "violations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "appliedAuditId" TEXT,
    "lastApplyError" TEXT,

    CONSTRAINT "ProductAiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductAiDraft_cell_run_key" ON "ProductAiDraft"("productId", "cellKey", "runId");

-- CreateIndex
CREATE INDEX "ProductAiDraft_status_createdAt_idx" ON "ProductAiDraft"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProductAiDraft_productId_status_idx" ON "ProductAiDraft"("productId", "status");

-- CreateIndex
CREATE INDEX "ProductAiDraft_runId_idx" ON "ProductAiDraft"("runId");

-- CreateIndex
CREATE INDEX "ProductAiDraft_productId_channel_marketplace_status_idx" ON "ProductAiDraft"("productId", "channel", "marketplace", "status");
