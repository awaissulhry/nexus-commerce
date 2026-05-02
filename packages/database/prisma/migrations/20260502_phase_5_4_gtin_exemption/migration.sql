-- Phase 5.4: GTIN exemption applications.
-- Idempotent CREATE TABLE — safe to re-run.

CREATE TABLE IF NOT EXISTS "GtinExemptionApplication" (
  "id"                    TEXT PRIMARY KEY,
  "brandName"             TEXT NOT NULL,
  "productIds"            TEXT[] NOT NULL DEFAULT '{}',
  "marketplace"           TEXT NOT NULL,

  "brandRegistrationType" TEXT NOT NULL,
  "trademarkNumber"       TEXT,
  "trademarkCountry"      TEXT,
  "trademarkDate"         TIMESTAMP(3),
  "trademarkCertUrl"      TEXT,
  "brandWebsite"          TEXT,

  "brandLetter"           TEXT NOT NULL,
  "brandLetterCustomised" BOOLEAN NOT NULL DEFAULT FALSE,
  "imagesProvided"        TEXT[] NOT NULL DEFAULT '{}',
  "imageValidation"       JSONB,

  "status"                TEXT NOT NULL DEFAULT 'DRAFT',
  "amazonCaseId"          TEXT,
  "rejectionReason"       TEXT,

  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "packageGeneratedAt"    TIMESTAMP(3),
  "submittedAt"           TIMESTAMP(3),
  "approvedAt"            TIMESTAMP(3),
  "rejectedAt"            TIMESTAMP(3),
  "updatedAt"             TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "GtinExemptionApplication_status_idx"
  ON "GtinExemptionApplication" ("status");

CREATE INDEX IF NOT EXISTS "GtinExemptionApplication_brandName_idx"
  ON "GtinExemptionApplication" ("brandName");

CREATE INDEX IF NOT EXISTS "GtinExemptionApplication_brandName_marketplace_idx"
  ON "GtinExemptionApplication" ("brandName", "marketplace");
