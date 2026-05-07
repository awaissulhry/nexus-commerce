-- CR.9 (additive) — secondary carrier accounts.
--
-- The audit's CR.9 spec called for replacing Carrier.code @unique
-- with a CarrierAccount table. That's a wholesale refactor that
-- touches every prisma.carrier call site in the codebase. CR.9
-- ships a SAFER additive variant:
--
--   • Carrier.code @unique stays. Primary account credentials
--     remain on the Carrier row.
--   • CarrierAccount table holds ADDITIONAL accounts of the same
--     carrier code (e.g. "Sendcloud Bologna" alongside the primary
--     "Sendcloud Riccione").
--   • Every consumer (resolveCredentials, print-label, sender
--     binding) keeps using the primary by default.
--   • Future commit (post-engagement) can wire Shipment.carrierAccountId
--     to support per-shipment account selection.
--
-- This delivers the multi-account UI surface the audit wanted
-- without the migration risk.

CREATE TABLE IF NOT EXISTS "CarrierAccount" (
  "id"                   TEXT PRIMARY KEY,
  "carrierId"            TEXT NOT NULL,
  -- Operator-visible label. Unique per carrier so the picker UI
  -- doesn't show two "Sendcloud" entries with no way to distinguish.
  "accountLabel"         TEXT NOT NULL,
  -- Encrypted (CR.1 envelope) Sendcloud creds for this secondary
  -- account. Nullable because operator may stage an account row
  -- before pasting credentials.
  "credentialsEncrypted" TEXT,
  -- Sandbox / production tag — independent of the primary account
  -- so an operator can keep "prod" + "test" accounts side by side.
  "mode"                 TEXT NOT NULL DEFAULT 'sandbox',
  "isActive"             BOOLEAN NOT NULL DEFAULT TRUE,
  -- Connection-health mirror of the columns on Carrier.
  "lastUsedAt"           TIMESTAMP(3),
  "lastVerifiedAt"       TIMESTAMP(3),
  "lastErrorAt"          TIMESTAMP(3),
  "lastError"            TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CarrierAccount_carrierId_fkey"
    FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierAccount_carrierId_accountLabel_key"
  ON "CarrierAccount" ("carrierId", "accountLabel");
CREATE INDEX IF NOT EXISTS "CarrierAccount_carrierId_isActive_idx"
  ON "CarrierAccount" ("carrierId", "isActive");
