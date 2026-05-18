-- H.2 — Amazon Ads API v1 unified export substrate
--
-- Additive only. Three concerns:
--   1. AmazonAdsExportJob table (parallel to AmazonAdsReportJob)
--   2. deliveryStatus + deliveryReasons on Campaign / AdGroup / AdTarget / AdProductAd
--   3. creativeJson + adType on AdProductAd (v1 multi-product creatives)

-- ── AmazonAdsExportJob ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AmazonAdsExportJob" (
  "id"               TEXT PRIMARY KEY,
  "profileId"        TEXT NOT NULL,
  "resource"         TEXT NOT NULL,
  "adProducts"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "externalExportId" TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "url"              TEXT,
  "urlExpiresAt"     TIMESTAMP(3),
  "fileSize"         INTEGER,
  "rowsIngested"     INTEGER NOT NULL DEFAULT 0,
  "errorMessage"     TEXT,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "configuration"    JSONB NOT NULL,
  "lastPolledAt"     TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  "completedAt"      TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "AmazonAdsExportJob_status_lastPolledAt_idx"
  ON "AmazonAdsExportJob" ("status", "lastPolledAt");
CREATE INDEX IF NOT EXISTS "AmazonAdsExportJob_profileId_resource_createdAt_idx"
  ON "AmazonAdsExportJob" ("profileId", "resource", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AmazonAdsExportJob_externalExportId_idx"
  ON "AmazonAdsExportJob" ("externalExportId");

-- ── delivery* columns on Campaign / AdGroup / AdTarget / AdProductAd ──────
ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "deliveryStatus"  TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "AdGroup"
  ADD COLUMN IF NOT EXISTS "deliveryStatus"  TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "AdTarget"
  ADD COLUMN IF NOT EXISTS "deliveryStatus"  TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "AdProductAd"
  ADD COLUMN IF NOT EXISTS "deliveryStatus"  TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── creativeJson + adType on AdProductAd (v1 multi-product creatives) ────
ALTER TABLE "AdProductAd"
  ADD COLUMN IF NOT EXISTS "creativeJson" JSONB,
  ADD COLUMN IF NOT EXISTS "adType"       TEXT;
