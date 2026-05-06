-- Rollback for H.16 compliance fields
DROP INDEX IF EXISTS "InboundShipmentItem_lotNumber_idx";
ALTER TABLE "InboundShipmentItem" DROP COLUMN IF EXISTS "expiryDate";
ALTER TABLE "InboundShipmentItem" DROP COLUMN IF EXISTS "lotNumber";

DROP INDEX IF EXISTS "Product_hsCode_idx";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "countryOfOrigin";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "hsCode";
