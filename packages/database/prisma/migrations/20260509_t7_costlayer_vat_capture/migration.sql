-- T.7 — VAT (IVA) treatment on StockCostLayer.
--
-- Italian fiscal law (DPR 633/72 Art. 19, Codice Civile Art. 2426)
-- requires inventory valuation to EXCLUDE VAT. If supplier-invoice
-- VAT leaks into the cost basis, year-end "rimanenze finali" is
-- overstated and IVA receivable is understated — material risk.
--
-- After this migration:
--  - unitCostVatExcluded   true when unitCost is already net of IVA
--                          (the Italian fiscal default; the receive
--                          path expects net costs by convention).
--                          false when caller explicitly capitalised
--                          a gross amount (legacy / non-IT supplier).
--  - vatRate               applicable VAT rate at receive time, e.g.
--                          0.2200 for the IT 22% standard rate, or
--                          0.0000 for intra-EU reverse-charge. NULL
--                          when not known.
--
-- The DB CHECK keeps vatRate in the [0, 1) half-open interval; a
-- 100% VAT rate would imply a doubled cost which is never legit.

ALTER TABLE "StockCostLayer"
  ADD COLUMN "unitCostVatExcluded" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "StockCostLayer"
  ADD COLUMN "vatRate" DECIMAL(5, 4);

ALTER TABLE "StockCostLayer"
  ADD CONSTRAINT "StockCostLayer_vatRate_range"
  CHECK ("vatRate" IS NULL OR ("vatRate" >= 0 AND "vatRate" < 1));
