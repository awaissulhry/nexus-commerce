-- IM.1: SkuAlias + StockImportJob tables for bulk inventory import wizard

CREATE TABLE "SkuAlias" (
    "id"        TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "alias"     TEXT NOT NULL,
    "raw"       TEXT NOT NULL,
    "source"    TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkuAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SkuAlias_alias_key" ON "SkuAlias"("alias");
CREATE INDEX "SkuAlias_productId_idx" ON "SkuAlias"("productId");

ALTER TABLE "SkuAlias" ADD CONSTRAINT "SkuAlias_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StockImportJob" (
    "id"           TEXT NOT NULL,
    "filename"     TEXT,
    "fileKind"     TEXT,
    "locationCode" TEXT NOT NULL,
    "mode"         TEXT NOT NULL,
    "target"       TEXT NOT NULL,
    "totalRows"    INTEGER NOT NULL DEFAULT 0,
    "succeeded"    INTEGER NOT NULL DEFAULT 0,
    "failed"       INTEGER NOT NULL DEFAULT 0,
    "skipped"      INTEGER NOT NULL DEFAULT 0,
    "status"       TEXT NOT NULL DEFAULT 'PENDING',
    "appliedAt"    TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorSummary" TEXT,
    "results"      JSONB,
    CONSTRAINT "StockImportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockImportJob_status_createdAt_idx" ON "StockImportJob"("status", "createdAt" DESC);
CREATE INDEX "StockImportJob_locationCode_idx" ON "StockImportJob"("locationCode");
