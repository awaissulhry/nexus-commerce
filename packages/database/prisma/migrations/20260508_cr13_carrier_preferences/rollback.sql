-- ROLLBACK for 20260508_cr13_carrier_preferences

ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "preferences";
