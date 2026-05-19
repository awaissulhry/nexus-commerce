-- Phase D — Italian fiscal fields on BrandSettings.
--
-- Five nullable columns:
--   piva           — Partita IVA, 11 digits, mod-11 checksum
--   codiceFiscale  — Codice Fiscale, 16 alphanumeric, control letter
--   sdiCode        — Sistema di Interscambio code, 7 alphanumeric
--   pecEmail       — Posta Elettronica Certificata (PEC) address
--   vatScheme      — enum-like text: ORDINARIO | FORFETTARIO | OSS |
--                    IOSS | ESENTE
--
-- All nullable so the existing seeded row keeps working without a
-- backfill. Strict checksum + format validation lives in the API
-- (apps/api/src/lib/italian-fiscal.ts); DB stays format-agnostic.

ALTER TABLE "BrandSettings"
  ADD COLUMN "piva"          TEXT,
  ADD COLUMN "codiceFiscale" TEXT,
  ADD COLUMN "sdiCode"       TEXT,
  ADD COLUMN "pecEmail"      TEXT,
  ADD COLUMN "vatScheme"     TEXT;
