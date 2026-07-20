-- IM.3.2 — async stock-import apply: live progress columns (additive).
ALTER TABLE "StockImportJob" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "StockImportJob" ADD COLUMN "progressAt" TIMESTAMP(3);
ALTER TABLE "StockImportJob" ADD COLUMN "processedRows" INTEGER NOT NULL DEFAULT 0;
