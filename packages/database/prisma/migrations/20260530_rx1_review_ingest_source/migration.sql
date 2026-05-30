-- RX.1 — Review provenance. Additive, online-safe: one nullable column
-- + one index on existing Review table. Lets the per-channel ingest-health
-- tile and operators distinguish fixture/seed rows from real ingested
-- reviews (import CSV, eBay API, Amazon VoC, Shopify webhook).

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "ingestSource" TEXT;

-- CreateIndex
CREATE INDEX "Review_channel_ingestedAt_idx" ON "Review"("channel", "ingestedAt");
