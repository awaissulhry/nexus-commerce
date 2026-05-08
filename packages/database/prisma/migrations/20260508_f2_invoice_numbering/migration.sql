-- F.2 — Italian fiscal-year invoice numbering.
--
-- Italian law (DPR 633/72 art. 21) requires invoice numbers to be:
--   1. Sequential within a fiscal year (Jan 1 to Dec 31)
--   2. Gap-free — auditors flag missing numbers as suspicious
--   3. Reset every January 1
--   4. Per-issuer (Xavia is one issuer; multi-tenant/multi-brand
--      would need a per-issuer namespace)
--
-- Format Xavia uses: "NNNNN/YYYY" (e.g. "00001/2026"). Five-digit
-- left-padded sequence + slash + four-digit year. Configurable per
-- issuer in a follow-up (multi-brand) but hardcoded for the
-- single-tenant case today.
--
-- Schema:
--   FiscalInvoiceCounter — one row per fiscal year, holds the
--     current max sequence. Service layer takes a SELECT FOR UPDATE
--     lock, increments + returns. Postgres advisory lock would also
--     work but the row-lock is more visible to audit.
--   FiscalInvoice — one row per assigned invoice number. orderId is
--     unique (an order has at most one fiscal invoice number).
--     fiscalYear + sequenceNumber form the gap-free uniqueness.

CREATE TABLE IF NOT EXISTS "FiscalInvoiceCounter" (
  "fiscalYear" INTEGER NOT NULL,
  -- Per-issuer namespace. Single tenant today ⇒ always 'XAVIA'.
  -- Multi-brand: one row per (year, issuer).
  "issuer"     TEXT    NOT NULL DEFAULT 'XAVIA',
  "current"    INTEGER NOT NULL DEFAULT 0,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalInvoiceCounter_pkey" PRIMARY KEY ("fiscalYear", "issuer")
);

CREATE TABLE IF NOT EXISTS "FiscalInvoice" (
  "id"             TEXT         NOT NULL,
  "orderId"        TEXT         NOT NULL,
  "issuer"         TEXT         NOT NULL DEFAULT 'XAVIA',
  "fiscalYear"     INTEGER      NOT NULL,
  "sequenceNumber" INTEGER      NOT NULL,
  -- Materialised for at-a-glance display + invoice PDF rendering.
  -- Format: "NNNNN/YYYY".
  "invoiceNumber"  TEXT         NOT NULL,
  -- For SDI submission audit trail (F.4).
  "sdiTransmissionId" TEXT,
  "sdiStatus"      TEXT, -- 'PENDING' | 'SENT' | 'ACCEPTED' | 'REJECTED' | NULL
  "issuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalInvoice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FiscalInvoice_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE
);

-- Gap-free uniqueness — a sequence number is reserved exactly once
-- per (year, issuer). Service-layer transaction prevents duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "FiscalInvoice_year_seq_key"
  ON "FiscalInvoice"("issuer", "fiscalYear", "sequenceNumber");

-- One invoice per order. Re-running the assignment is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "FiscalInvoice_orderId_key"
  ON "FiscalInvoice"("orderId");

CREATE INDEX IF NOT EXISTS "FiscalInvoice_invoiceNumber_idx"
  ON "FiscalInvoice"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "FiscalInvoice_issuedAt_idx"
  ON "FiscalInvoice"("issuedAt");
CREATE INDEX IF NOT EXISTS "FiscalInvoice_sdiStatus_idx"
  ON "FiscalInvoice"("sdiStatus");
