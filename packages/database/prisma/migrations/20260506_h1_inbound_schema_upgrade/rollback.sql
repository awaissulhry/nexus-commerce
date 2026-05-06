-- ROLLBACK for 20260506_h1_inbound_schema_upgrade
--
-- Drops the H.1 surface entirely. Enum values are forever in Postgres
-- (no DROP VALUE) — the four new InboundStatus values stay; if no
-- row uses them, they're benign. Code rollback: redeploy a commit
-- older than H.1; the older code reads only the original columns
-- and ignores the new ones.

BEGIN;

DROP TABLE IF EXISTS "InboundDiscrepancy";
DROP TABLE IF EXISTS "InboundShipmentAttachment";

ALTER TABLE "InboundShipmentItem" DROP COLUMN IF EXISTS "unitCostCents";
ALTER TABLE "InboundShipmentItem" DROP COLUMN IF EXISTS "costVarianceCents";
ALTER TABLE "InboundShipmentItem" DROP COLUMN IF EXISTS "photoUrls";

DROP INDEX IF EXISTS "InboundShipment_purchaseOrderId_idx";
DROP INDEX IF EXISTS "InboundShipment_carrierCode_idx";
DROP INDEX IF EXISTS "InboundShipment_trackingNumber_idx";
DROP INDEX IF EXISTS "InboundShipment_expectedAt_idx";

ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "asnFileUrl";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "carrierCode";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "trackingNumber";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "trackingUrl";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "currencyCode";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "exchangeRate";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "shippingCostCents";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "customsCostCents";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "dutiesCostCents";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "insuranceCostCents";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "createdById";
ALTER TABLE "InboundShipment" DROP COLUMN IF EXISTS "receivedById";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20260506_h1_inbound_schema_upgrade';

COMMIT;
