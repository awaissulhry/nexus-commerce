-- SQP.2 — outstanding Brand Analytics report requests, so collection can happen later.
-- Purely additive: one new table, nothing altered, nothing dropped.
CREATE TABLE "SqpReportRequest" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "reportPeriod" TEXT NOT NULL DEFAULT 'WEEK',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "reportDocumentId" TEXT,
    "rowsParsed" INTEGER,
    "rowsUpserted" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SqpReportRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SqpReportRequest_reportId_key" ON "SqpReportRequest"("reportId");
CREATE INDEX "SqpReportRequest_status_requestedAt_idx" ON "SqpReportRequest"("status", "requestedAt");
CREATE INDEX "SqpReportRequest_marketplace_startDate_idx" ON "SqpReportRequest"("marketplace", "startDate");
CREATE INDEX "SqpReportRequest_requestedAt_idx" ON "SqpReportRequest"("requestedAt");
