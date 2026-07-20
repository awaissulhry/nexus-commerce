-- IM.3.4 — batch revert linkage (additive).
ALTER TABLE "StockImportJob" ADD COLUMN "revertedByJobId" TEXT;
