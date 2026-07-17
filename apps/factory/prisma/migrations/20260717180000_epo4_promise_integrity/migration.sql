-- EPO.4 — promise integrity + EPF D-9 field request (all additive, nullable/defaulted)
ALTER TABLE "Order" ADD COLUMN "originalPromiseDateAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "clientRef" TEXT;
ALTER TABLE "Order" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "remakeOfId" TEXT;

-- backfill: today's promise becomes the recorded original for existing orders
-- (the audit trail keeps the honest history; from here on the first promise is immutable)
UPDATE "Order" SET "originalPromiseDateAt" = "promiseDateAt" WHERE "promiseDateAt" IS NOT NULL;
