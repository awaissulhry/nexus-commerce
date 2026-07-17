-- Round-trip integrity — Lane-B row snapshot (additive)
ALTER TABLE "SharedListingMembership" ADD COLUMN "flatFileSnapshot" JSONB;
