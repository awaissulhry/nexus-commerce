-- SK3 (Keyword Tracker rank backend): KeywordRank — a time-series of organic / paid (sponsored)
-- rank snapshots per keyword × marketplace, feeding the Keyword Tracker report + the
-- KEYWORD_RANK_BID rule. Additive only: a brand-new table + indexes. No existing table changed.
CREATE TABLE IF NOT EXISTS "KeywordRank" (
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "asin" TEXT,
    "organicRank" INTEGER,
    "sponsoredRank" INTEGER,
    "searchVolume" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KeywordRank_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "KeywordRank_keyword_marketplace_capturedAt_idx" ON "KeywordRank"("keyword", "marketplace", "capturedAt" DESC);
CREATE INDEX IF NOT EXISTS "KeywordRank_marketplace_capturedAt_idx" ON "KeywordRank"("marketplace", "capturedAt" DESC);
CREATE INDEX IF NOT EXISTS "KeywordRank_asin_idx" ON "KeywordRank"("asin");
