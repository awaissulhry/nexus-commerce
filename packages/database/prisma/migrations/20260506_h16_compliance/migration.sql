-- =====================================================================
-- H.16 — Compliance fields (HS code, country of origin, lot tracking)
--
-- Master-data fields on Product (rarely vary) and per-line fields on
-- InboundShipmentItem (lot/expiry vary by batch). All nullable so
-- existing rows aren't impacted; the inbound surface fills them in
-- progressively as deliveries arrive.
--
-- Why this matters operationally:
-- - HS code: required on customs declarations for any non-EU shipment.
--   Stored once per product; reused on every export/import.
-- - Country of origin: mandatory labeling info under EU consumer law
--   (Reg. 2019/1020). Stored once per product.
-- - Lot number + expiry: per-receive batch identification. Critical
--   for safety-recall scenarios on Xavia's category (helmets, body
--   armor) — the recall scope is "this lot from this date" and Nexus
--   needs to be able to answer "which units did we receive in that
--   lot, and where are they now".
-- =====================================================================

-- ── Product: master-data compliance ─────────────────────────────────
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "hsCode"          TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "countryOfOrigin" TEXT;

-- Index on hsCode lets the customs-export view (future) group by code.
CREATE INDEX IF NOT EXISTS "Product_hsCode_idx" ON "Product"("hsCode");

-- ── InboundShipmentItem: per-line lot tracking ──────────────────────
ALTER TABLE "InboundShipmentItem" ADD COLUMN IF NOT EXISTS "lotNumber" TEXT;
ALTER TABLE "InboundShipmentItem" ADD COLUMN IF NOT EXISTS "expiryDate" TIMESTAMP(3);

-- Index on lotNumber for "find every receive of lot X" recall lookups.
CREATE INDEX IF NOT EXISTS "InboundShipmentItem_lotNumber_idx" ON "InboundShipmentItem"("lotNumber");
