-- R.8 — Amazon FBA Restock Inventory Recommendations integration.
-- Two new tables (report metadata + per-SKU rows) plus three audit
-- columns on ReplenishmentRecommendation that capture Amazon's
-- recommended qty + delta % at rec generation time.

CREATE TABLE "FbaRestockReport" (
  "id"               TEXT NOT NULL,
  "marketplace"      TEXT NOT NULL,
  "marketplaceCode"  TEXT NOT NULL,
  "status"           TEXT NOT NULL,
  "reportId"         TEXT,
  "reportDocumentId" TEXT,
  "requestedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"      TIMESTAMP(3),
  "rowCount"         INTEGER NOT NULL DEFAULT 0,
  "errorMessage"     TEXT,
  "payloadDigest"    TEXT,
  "triggeredBy"      TEXT NOT NULL,
  "durationMs"       INTEGER,

  CONSTRAINT "FbaRestockReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FbaRestockReport_marketplace_idx"
  ON "FbaRestockReport"("marketplace");
CREATE INDEX "FbaRestockReport_status_idx"
  ON "FbaRestockReport"("status");
CREATE INDEX "FbaRestockReport_requestedAt_idx"
  ON "FbaRestockReport"("requestedAt");

CREATE TABLE "FbaRestockRow" (
  "id"                          TEXT NOT NULL,
  "reportId"                    TEXT NOT NULL,
  "sku"                         TEXT NOT NULL,
  "marketplace"                 TEXT NOT NULL,
  "recommendedReplenishmentQty" INTEGER,
  "daysOfSupply"                DECIMAL(8,2),
  "recommendedShipDate"         TIMESTAMP(3),
  "daysToInbound"               INTEGER,
  "salesPace30dUnits"           INTEGER,
  "salesShortageUnits"          INTEGER,
  "alertType"                   TEXT,
  "asOf"                        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FbaRestockRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FbaRestockRow_sku_marketplace_reportId_key"
  ON "FbaRestockRow"("sku", "marketplace", "reportId");
CREATE INDEX "FbaRestockRow_sku_marketplace_asOf_idx"
  ON "FbaRestockRow"("sku", "marketplace", "asOf");
CREATE INDEX "FbaRestockRow_reportId_idx"
  ON "FbaRestockRow"("reportId");

ALTER TABLE "FbaRestockRow"
  ADD CONSTRAINT "FbaRestockRow_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "FbaRestockReport"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReplenishmentRecommendation"
  ADD COLUMN "amazonRecommendedQty" INTEGER,
  ADD COLUMN "amazonDeltaPct"       DECIMAL(8,2),
  ADD COLUMN "amazonReportAsOf"     TIMESTAMP(3);
