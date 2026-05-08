-- F.1 — Italian fiscal compliance: codice fiscale + Partita IVA +
-- per-item VAT rate.
--
-- Why now: Xavia primary market is Amazon IT. For B2B sales (which
-- is most motorcycle-gear purchases for fleets, riding schools,
-- couriers), Italian law (DPR 633/72) requires:
--   - Buyer codice fiscale (16 chars, individuals) OR partita IVA
--     (11 digits, businesses) on every invoice
--   - Per-line VAT rate breakdown (22% / 10% / 4%) — motorcycle gear
--     is 22% but a multi-line order with shipping or merch may mix
--   - Sequential invoice numbering reset annually (F.2)
--   - Electronic invoice via SDI (FatturaPA XML, F.4)
--
-- Pre-F.1, none of this existed in the schema. Operators had to
-- manually transcribe customer fiscal data into a parallel
-- accounting tool — error-prone and not auditable. F.1 lands the
-- columns; F.2/F.3/F.4 land the numbering, PDFs, and SDI XML.
--
-- Snapshot vs live: codiceFiscale + partitaIva exist on BOTH
-- Customer (canonical, editable) AND Order (snapshot at order
-- time). Italian fiscal law cares about the value at the moment
-- of the sale; if the customer later updates their VAT number,
-- historical invoices stay locked to the snapshotted value.

-- ── Customer fiscal identity ─────────────────────────────────────────
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "codiceFiscale" TEXT,
  ADD COLUMN IF NOT EXISTS "partitaIva"    TEXT,
  -- B2B vs B2C distinction: drives invoice-vs-receipt rendering and
  -- whether SDI submission is required (B2B only).
  ADD COLUMN IF NOT EXISTS "fiscalKind"    TEXT, -- 'B2B' | 'B2C' | NULL
  -- PEC (Italian certified email) for SDI fallback delivery when
  -- the customer doesn't provide a destination code (codice
  -- destinatario). NULL when not provided.
  ADD COLUMN IF NOT EXISTS "pecEmail"      TEXT,
  ADD COLUMN IF NOT EXISTS "codiceDestinatario" TEXT;

-- ── Order: snapshot the customer's fiscal data at sale time ──────────
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "codiceFiscale" TEXT,
  ADD COLUMN IF NOT EXISTS "partitaIva"    TEXT,
  ADD COLUMN IF NOT EXISTS "fiscalKind"    TEXT,
  ADD COLUMN IF NOT EXISTS "pecEmail"      TEXT,
  ADD COLUMN IF NOT EXISTS "codiceDestinatario" TEXT;

-- ── OrderItem: per-line VAT rate ─────────────────────────────────────
-- Stored as percent (22, 10, 4). NULL on legacy rows; F.3 PDF +
-- F.4 SDI XML default to 22 when NULL on Italian-marketplace orders.
ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "itVatRatePct" NUMERIC(5,2);

-- Backfill: motorcycle-gear ⇒ 22% standard rate. Apply only to
-- Italian-marketplace orders so non-IT lines stay NULL (their VAT
-- treatment is the destination country's, not Italy's).
UPDATE "OrderItem" oi
   SET "itVatRatePct" = 22.00
  FROM "Order" o
 WHERE oi."orderId" = o.id
   AND o.marketplace = 'IT'
   AND oi."itVatRatePct" IS NULL;

-- Indexes for the F.4 SDI XML generator (filters Italian orders by
-- fiscal kind for batch invoice runs) and the /customers list's
-- "B2B vs B2C" filter chip (P2 follow-up).
CREATE INDEX IF NOT EXISTS "Customer_fiscalKind_idx"
  ON "Customer"("fiscalKind");
CREATE INDEX IF NOT EXISTS "Order_fiscalKind_idx"
  ON "Order"("fiscalKind");
