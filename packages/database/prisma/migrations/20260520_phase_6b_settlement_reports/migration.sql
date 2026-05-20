-- Phase 6.B — SettlementReport (Amazon SP-API GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2).
--
-- Bank-reconciliation gap surfaced by the 2026-05-20 audit: granular
-- financial events (listFinancialEvents → FinancialTransaction) capture
-- per-order revenue but cannot answer "did this match what Amazon
-- actually deposited in our bank?" Settlement reports are Amazon's
-- weekly/bi-weekly bank-side aggregation — one report per settlement
-- period per marketplace, with a deposit total and per-line breakdown.
--
-- This table stores the SUMMARY (1 row per settlement period); the
-- full per-line raw flat-file body is in `rawBody` for future
-- per-transaction reconciliation. Splitting into a SettlementLine
-- table is deferred until a real ledger-matching feature ships.
--
-- Idempotent: (marketplaceId, reportId) is unique so re-running the
-- sync upserts. Manual operator notes survive across re-syncs via the
-- separate `reconcileNotes` column.

CREATE TABLE "SettlementReport" (
    "id"              TEXT NOT NULL,
    -- SP-API identifiers
    "reportId"        TEXT NOT NULL,
    "documentId"      TEXT,
    "reportType"      TEXT NOT NULL DEFAULT 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    -- Marketplace scope
    "marketplaceId"   TEXT NOT NULL,
    -- Settlement window (from the report header)
    "startDate"       TIMESTAMP(3) NOT NULL,
    "endDate"         TIMESTAMP(3) NOT NULL,
    -- Bank-side totals (from the summary row)
    "depositDate"     TIMESTAMP(3),
    "totalAmount"     DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currencyCode"    TEXT NOT NULL DEFAULT 'EUR',
    -- Counts derived during parse
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    -- Raw flat-file body (tab-separated). May be NULL when
    -- ingester is in "summary-only" mode. Sized so even multi-MB
    -- monthly settlements fit (Postgres TEXT has no length cap).
    "rawBody"         TEXT,
    -- Tracking
    "fetchedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"          TEXT NOT NULL DEFAULT 'INGESTED',
    "reconcileNotes"  TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SettlementReport_pkey" PRIMARY KEY ("id")
);

-- One row per (marketplace, settlement). reportId is globally unique
-- on Amazon's side so the (marketplaceId, reportId) pair is too —
-- but a global unique on reportId alone gives us idempotent upsert
-- semantics without needing the composite.
CREATE UNIQUE INDEX "SettlementReport_reportId_key" ON "SettlementReport"("reportId");
CREATE INDEX "SettlementReport_marketplaceId_startDate_idx" ON "SettlementReport"("marketplaceId", "startDate");
CREATE INDEX "SettlementReport_depositDate_idx" ON "SettlementReport"("depositDate");
