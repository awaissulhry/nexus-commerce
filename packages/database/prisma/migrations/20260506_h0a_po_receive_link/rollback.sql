-- ROLLBACK for 20260506_h0a_po_receive_link
--
-- Safe at any time. Drops the FK + column. The backfill script wrote
-- to existing InboundShipmentItem rows; rolling back the column drops
-- those values but leaves the rows themselves intact. The PO line
-- quantityReceived values it derived stay as-is — they're fed off the
-- column being dropped, so there's no automatic rollback for those
-- (and no need: the values are correct as derived; dropping the column
-- just removes the propagation path going forward).

BEGIN;

ALTER TABLE "InboundShipmentItem" DROP CONSTRAINT IF EXISTS "InboundShipmentItem_purchaseOrderItemId_fkey";
DROP INDEX IF EXISTS "InboundShipmentItem_purchaseOrderItemId_idx";
ALTER TABLE "InboundShipmentItem" DROP COLUMN IF EXISTS "purchaseOrderItemId";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20260506_h0a_po_receive_link';

COMMIT;
