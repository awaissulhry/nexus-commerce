-- IN.4 — Add driftCount to ProductReadCache
-- Counts ChannelListings where any followMaster* = false (channel override active).
-- Populated by ProductReadCacheService.refresh(); defaults to 0.

ALTER TABLE "ProductReadCache" ADD COLUMN IF NOT EXISTS "driftCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "ProductReadCache_driftCount_idx" ON "ProductReadCache"("driftCount");
