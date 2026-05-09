-- F1.4 — Italian nota di credito (credit note) infrastructure.
--
-- Per DPR 633/72 Art. 26, every refund of a sale invoice MUST be
-- issued as a credit note (TipoDocumento TD04 in FatturaPA) so the
-- VAT is reclaimed from the state. Without this, refunded VAT
-- remains owed — a high-stakes audit failure.
--
-- Schema mirrors FiscalInvoice + FiscalInvoiceCounter for parity:
-- gap-free per-(fiscalYear, issuer) sequence, idempotent on refundId.

CREATE TABLE "CreditNoteCounter" (
  "fiscalYear" INTEGER NOT NULL,
  "issuer"     TEXT    NOT NULL DEFAULT 'XAVIA',
  "current"    INTEGER NOT NULL DEFAULT 0,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditNoteCounter_pkey" PRIMARY KEY ("fiscalYear", "issuer")
);

CREATE TABLE "CreditNote" (
  "id"                TEXT NOT NULL,
  "refundId"          TEXT NOT NULL,
  "originalInvoiceId" TEXT,
  "issuer"            TEXT NOT NULL DEFAULT 'XAVIA',
  "fiscalYear"        INTEGER NOT NULL,
  "sequenceNumber"    INTEGER NOT NULL,
  "creditNoteNumber"  TEXT NOT NULL,
  "amountCents"       INTEGER NOT NULL,
  "currencyCode"      TEXT NOT NULL DEFAULT 'EUR',
  "causale"           TEXT,
  "sdiTransmissionId" TEXT,
  "sdiStatus"         TEXT,
  "issuedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditNote_refundId_key"
  ON "CreditNote"("refundId");

CREATE UNIQUE INDEX "CreditNote_issuer_fiscalYear_sequenceNumber_key"
  ON "CreditNote"("issuer", "fiscalYear", "sequenceNumber");

CREATE INDEX "CreditNote_refundId_idx"
  ON "CreditNote"("refundId");

CREATE INDEX "CreditNote_creditNoteNumber_idx"
  ON "CreditNote"("creditNoteNumber");

CREATE INDEX "CreditNote_issuedAt_idx"
  ON "CreditNote"("issuedAt");

CREATE INDEX "CreditNote_sdiStatus_idx"
  ON "CreditNote"("sdiStatus");

CREATE INDEX "CreditNote_originalInvoiceId_idx"
  ON "CreditNote"("originalInvoiceId");

ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "Refund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_originalInvoiceId_fkey"
  FOREIGN KEY ("originalInvoiceId") REFERENCES "FiscalInvoice"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Amount must be positive — credit notes always represent a refund
-- of value, never zero or negative entries.
ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_amountCents_positive"
  CHECK ("amountCents" > 0);
