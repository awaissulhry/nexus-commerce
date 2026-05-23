-- PO-Plus.7 — Cache the most-recent observed landed cost on
-- SupplierProduct so replenishment recommendations can use
-- "true cost" (post-shipping/customs) over factory cost.
--
-- Populated by the "Push to catalog" button on the PO.11 three-way
-- match panel; updated each time the operator commits a fresh
-- landed-cost figure from a received PO.

ALTER TABLE "SupplierProduct"
  ADD COLUMN "lastLandedCostCents"     INTEGER,
  ADD COLUMN "lastLandedCostUpdatedAt" TIMESTAMP(3);
