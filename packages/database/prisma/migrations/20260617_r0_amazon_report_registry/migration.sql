-- R0.1 — Amazon Data & Reports strategy (docs/AMAZON_DATA_STRATEGY.md).
-- The generic "every report pull, stamped with its freshness" registry.
-- One row per report request (Reports API / Data Kiosk / data-API pull),
-- regardless of where the parsed rows land (SettlementReport, etc. stay).
-- Additive: one new table, zero changes to existing tables. Ships empty,
-- so this is non-destructive and safe to deploy ahead of R0.2's writers.

-- CreateTable
CREATE TABLE "AmazonReportRun" (
    "id" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "marketplace" TEXT,
    "source" TEXT NOT NULL DEFAULT 'REPORTS_API',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reportId" TEXT,
    "reportDocumentId" TEXT,
    "dataStartTime" TIMESTAMP(3),
    "dataEndTime" TIMESTAMP(3),
    "rowCount" INTEGER,
    "rawStored" BOOLEAN NOT NULL DEFAULT false,
    "rawRef" TEXT,
    "freshAsOf" TIMESTAMP(3),
    "errorMessage" TEXT,
    "triggeredBy" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AmazonReportRun_reportId_key" ON "AmazonReportRun"("reportId");

-- CreateIndex
CREATE INDEX "AmazonReportRun_reportType_requestedAt_idx" ON "AmazonReportRun"("reportType", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonReportRun_marketplace_reportType_idx" ON "AmazonReportRun"("marketplace", "reportType");

-- CreateIndex
CREATE INDEX "AmazonReportRun_status_requestedAt_idx" ON "AmazonReportRun"("status", "requestedAt" DESC);
