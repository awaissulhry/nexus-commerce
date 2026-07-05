-- FP8: Shipping needs a destination + a parcel it doesn't have yet.
-- Remember a party's ship-to (for prefill on the next order), and snapshot the
-- ship-to + parcel onto the shipment so a later address edit never rewrites a
-- label that was already bought and printed.
ALTER TABLE "Party" ADD COLUMN "addressJson" JSONB;
ALTER TABLE "Shipment" ADD COLUMN "labelFormat" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "shipToJson" JSONB;
ALTER TABLE "Shipment" ADD COLUMN "parcelJson" JSONB;
