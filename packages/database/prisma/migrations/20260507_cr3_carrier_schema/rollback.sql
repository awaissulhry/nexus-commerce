-- ROLLBACK for 20260507_cr3_carrier_schema
--
-- Drops the four new tables (children first to satisfy FKs) and
-- the seven Carrier columns. Indexes drop with their tables.
-- Carrier_isActive_idx + Carrier_lastUsedAt_idx drop with the column
-- indices via the explicit DROP INDEX. ON DELETE CASCADE on the FKs
-- means each table's children disappear cleanly.

DROP TABLE IF EXISTS "PickupSchedule";
DROP TABLE IF EXISTS "CarrierMetric";
DROP TABLE IF EXISTS "CarrierServiceMapping";
DROP TABLE IF EXISTS "CarrierService";

DROP INDEX IF EXISTS "Carrier_isActive_idx";
DROP INDEX IF EXISTS "Carrier_lastUsedAt_idx";

ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "lastUsedAt";
ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "lastVerifiedAt";
ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "lastErrorAt";
ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "lastError";
ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "accountLabel";
ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "mode";
ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "webhookSecret";
