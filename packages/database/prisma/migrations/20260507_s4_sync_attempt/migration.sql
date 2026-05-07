-- S.4 — Create the SyncAttempt audit table.
--
-- One row per resync attempt against a ChannelListing. Powers the
-- drawer's Sync tab timeline (real history, not synthesized) and is
-- the foundation for cron-driven drift checks (S.4b) and webhook
-- ingestion (S.4c).
--
-- Other column-level drift between schema.prisma and the live DB is
-- intentionally NOT addressed here — see TECH_DEBT #37 (column-level
-- drift detection) for that work. This migration only creates the
-- new table + its indexes + the FK back to ChannelListing.

-- CreateTable
CREATE TABLE "SyncAttempt" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncAttempt_listingId_attemptedAt_idx" ON "SyncAttempt"("listingId", "attemptedAt");

-- CreateIndex
CREATE INDEX "SyncAttempt_status_idx" ON "SyncAttempt"("status");

-- CreateIndex
CREATE INDEX "SyncAttempt_source_idx" ON "SyncAttempt"("source");

-- AddForeignKey
ALTER TABLE "SyncAttempt" ADD CONSTRAINT "SyncAttempt_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
