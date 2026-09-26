-- Keep old checkpoints for additive rollout, but restart reconciliation from T0 using creation/ID.
ALTER TABLE "EtsyReceiptIngest" ADD COLUMN "scanCreatedThrough" TIMESTAMP(3), ADD COLUMN "scanExpectedCount" INTEGER;
-- Etsy exposes creation timestamps in whole seconds. Include the activation second conservatively.
ALTER TABLE "EtsyReceiptIngest" ALTER COLUMN "activatedAt" SET DEFAULT date_trunc('second'::text, clock_timestamp());
