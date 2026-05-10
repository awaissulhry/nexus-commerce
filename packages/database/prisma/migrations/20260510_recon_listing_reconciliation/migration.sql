-- CreateTable: ListingReconciliation
-- Phase RECON: stores every Amazon/eBay listing discovered during a
-- reconciliation run and its match status against Nexus products.
-- Operator must CONFIRM every row before Nexus writes externalListingId
-- back to ChannelListing.

CREATE TABLE "ListingReconciliation" (
    "id"                   TEXT NOT NULL,
    "channel"              TEXT NOT NULL,
    "marketplace"          TEXT NOT NULL,
    "externalSku"          TEXT NOT NULL,
    "externalListingId"    TEXT,
    "parentAsin"           TEXT,
    "title"                TEXT,
    "channelPrice"         DECIMAL(10,2),
    "channelQuantity"      INTEGER,
    "channelStatus"        TEXT,
    "matchedProductId"     TEXT,
    "matchedVariationId"   TEXT,
    "matchMethod"          TEXT,
    "matchConfidence"      DOUBLE PRECISION,
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "conflictNotes"        TEXT,
    "reviewedBy"           TEXT,
    "reviewedAt"           TIMESTAMP(3),
    "runId"                TEXT NOT NULL,
    "importedAt"           TIMESTAMP(3),
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingReconciliation_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one row per (channel, marketplace, externalSku).
-- Re-running a reconciliation upserts on this key so prior decisions survive.
CREATE UNIQUE INDEX "ListingReconciliation_channel_marketplace_externalSku_key"
    ON "ListingReconciliation"("channel", "marketplace", "externalSku");

-- Indexes for the review UI (filter by status) and match lookup
CREATE INDEX "ListingReconciliation_channel_marketplace_status_idx"
    ON "ListingReconciliation"("channel", "marketplace", "reconciliationStatus");

CREATE INDEX "ListingReconciliation_runId_idx"
    ON "ListingReconciliation"("runId");

CREATE INDEX "ListingReconciliation_matchedProductId_idx"
    ON "ListingReconciliation"("matchedProductId");

-- Auto-update updatedAt on row change
CREATE OR REPLACE FUNCTION update_listing_reconciliation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER listing_reconciliation_updated_at
    BEFORE UPDATE ON "ListingReconciliation"
    FOR EACH ROW
    EXECUTE PROCEDURE update_listing_reconciliation_updated_at();
