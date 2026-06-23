-- ALA Phase 4 — ListingIssue: mirror of Listings-Items API issues
-- (code / severity / message / attributeNames / categories) per ChannelListing,
-- powering the Pre-Flight health panel + listing-health scoring. Open/resolved
-- lifecycle. ADDITIVE: one new table only, no changes to existing tables, no
-- backfill. Guarded so a partial re-run is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ListingIssue" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "message" TEXT NOT NULL,
    "attributeNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'listings-api',
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "ListingIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ListingIssue_listingId_fingerprint_key" ON "ListingIssue"("listingId", "fingerprint");
CREATE INDEX IF NOT EXISTS "ListingIssue_listingId_resolvedAt_idx" ON "ListingIssue"("listingId", "resolvedAt");
CREATE INDEX IF NOT EXISTS "ListingIssue_severity_idx" ON "ListingIssue"("severity");

-- AddForeignKey (guarded — ADD CONSTRAINT has no IF NOT EXISTS)
DO $$ BEGIN
  ALTER TABLE "ListingIssue"
    ADD CONSTRAINT "ListingIssue_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
