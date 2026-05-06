-- =====================================================================
-- H.0a — link InboundShipmentItem to PurchaseOrderItem
--
-- Pre-roadmap correctness fix before the inbound rebuild. Adds the FK
-- so the PO can stay in lock-step with received quantities. Receiving
-- code in the same commit reads InboundShipmentItem rows linked to a
-- PurchaseOrderItem and sums quantityReceived back onto the PO line.
-- =====================================================================

-- Add the FK column (nullable). DEFAULT nothing — backfill happens in
-- a separate idempotent script after migrate-deploy lands the column.
ALTER TABLE "InboundShipmentItem" ADD COLUMN "purchaseOrderItemId" TEXT;

CREATE INDEX "InboundShipmentItem_purchaseOrderItemId_idx"
  ON "InboundShipmentItem"("purchaseOrderItemId");

ALTER TABLE "InboundShipmentItem"
  ADD CONSTRAINT "InboundShipmentItem_purchaseOrderItemId_fkey"
  FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
