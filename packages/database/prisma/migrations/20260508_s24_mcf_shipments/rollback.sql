-- Rollback for S.24 MCFShipment table.
DROP INDEX IF EXISTS "MCFShipment_requestedAt_idx";
DROP INDEX IF EXISTS "MCFShipment_status_idx";
DROP INDEX IF EXISTS "MCFShipment_orderId_idx";
DROP INDEX IF EXISTS "MCFShipment_amazonFulfillmentOrderId_key";
DROP TABLE IF EXISTS "MCFShipment";
