-- FP3 — quotes: public accept token + validity/sent timestamps + converted-order link (additive)
ALTER TABLE "Quote" ADD COLUMN "validUntilAt" DATETIME;
ALTER TABLE "Quote" ADD COLUMN "sentAt" DATETIME;
ALTER TABLE "Quote" ADD COLUMN "acceptTokenHash" TEXT;
ALTER TABLE "Quote" ADD COLUMN "convertedOrderId" TEXT;
CREATE UNIQUE INDEX "Quote_acceptTokenHash_key" ON "Quote"("acceptTokenHash");
