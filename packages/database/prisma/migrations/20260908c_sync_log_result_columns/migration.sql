BEGIN;
-- These existing Prisma fields never received a SQL migration. Keep this additive
-- for deployed databases and compatible with baselines created from the schema.
ALTER TABLE "SyncLog" ADD COLUMN IF NOT EXISTS "itemsSuccessful" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SyncLog" ADD COLUMN IF NOT EXISTS "details" JSONB;
COMMIT;
