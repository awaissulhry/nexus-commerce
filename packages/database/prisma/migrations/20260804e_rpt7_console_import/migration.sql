-- RPT.7 — imported Amazon console reports. Purely additive: two new tables.

CREATE TABLE "AdsConsoleImport" (
    "id"              TEXT NOT NULL,
    "fileName"        TEXT NOT NULL,
    "fileSize"        INTEGER NOT NULL,
    "format"          TEXT NOT NULL DEFAULT 'unified-report',
    "status"          TEXT NOT NULL DEFAULT 'PREVIEW',
    "rowsRead"        INTEGER NOT NULL DEFAULT 0,
    "rowsMerged"      INTEGER NOT NULL DEFAULT 0,
    "rowsNew"         INTEGER NOT NULL DEFAULT 0,
    "rowsUnchanged"   INTEGER NOT NULL DEFAULT 0,
    "rowsConflicting" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped"     INTEGER NOT NULL DEFAULT 0,
    "rowsErrored"     INTEGER NOT NULL DEFAULT 0,
    "windowStart"     DATE,
    "windowEnd"       DATE,
    "impressions"     BIGINT NOT NULL DEFAULT 0,
    "clicks"          BIGINT NOT NULL DEFAULT 0,
    "costCents"       BIGINT NOT NULL DEFAULT 0,
    "salesCents"      BIGINT NOT NULL DEFAULT 0,
    "purchases"       INTEGER NOT NULL DEFAULT 0,
    "errors"          JSONB,
    "notes"           TEXT,
    "uploadedBy"      TEXT NOT NULL DEFAULT 'default-user',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt"     TIMESTAMP(3),
    CONSTRAINT "AdsConsoleImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdsConsoleRow" (
    "id"            TEXT NOT NULL,
    "importId"      TEXT NOT NULL,
    "windowStart"   DATE NOT NULL,
    "windowEnd"     DATE NOT NULL,
    "marketplace"   TEXT NOT NULL,
    "adProduct"     TEXT NOT NULL,
    "campaignId"    TEXT NOT NULL,
    "campaignName"  TEXT,
    "portfolioName" TEXT,
    "adGroupId"     TEXT,
    "adGroupName"   TEXT,
    "adId"          TEXT,
    "asin"          TEXT,
    "sku"           TEXT,
    "placement"     TEXT,
    "targetId"      TEXT,
    "targeting"     TEXT,
    "matchType"     TEXT,
    "searchTerm"    TEXT,
    "impressions"   INTEGER NOT NULL DEFAULT 0,
    "clicks"        INTEGER NOT NULL DEFAULT 0,
    "costCents"     INTEGER NOT NULL DEFAULT 0,
    "salesCents"    INTEGER NOT NULL DEFAULT 0,
    "purchases"     INTEGER NOT NULL DEFAULT 0,
    "sourceRows"    INTEGER NOT NULL DEFAULT 1,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdsConsoleRow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdsConsoleImport_status_createdAt_idx" ON "AdsConsoleImport"("status", "createdAt");
CREATE UNIQUE INDEX "AdsConsoleRow_natural_key" ON "AdsConsoleRow"("importId","windowStart","windowEnd","campaignId","adGroupId","adId","targetId","searchTerm","placement","marketplace");
CREATE INDEX "AdsConsoleRow_importId_searchTerm_idx" ON "AdsConsoleRow"("importId", "searchTerm");
CREATE INDEX "AdsConsoleRow_marketplace_windowStart_idx" ON "AdsConsoleRow"("marketplace", "windowStart");

ALTER TABLE "AdsConsoleRow" ADD CONSTRAINT "AdsConsoleRow_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "AdsConsoleImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
