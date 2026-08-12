-- NEG.5 — the operator's "this contradiction is deliberate" mark.
--
-- A NEW TABLE, not a column on AdKeywordProtection. That table has seven production readers and
-- two of them (share-of-voice.service.ts:347, keyword-watchlist.service.ts:66) read a WHITELIST
-- row as the account's definition of a brand term, selecting term/matchType/isPrefix/marketplace
-- and never campaignId — so a campaign-scoped exemption filed there would be read account-wide as
-- "this is one of our brands". And ads-write-gate.ts:308-313 ANDs
-- (campaignId IS NULL OR campaignId = ctx.campaignId), which NARROWS a protection to one campaign
-- rather than exempting that campaign from it: the exact inverse of what the mark means.
--
-- Grain is (protected term x campaign). One decision covers every current and future negation of
-- that term in that campaign; the audit reports the new ones rather than absorbing them.
CREATE TABLE "AdNegativeReview" (
    "id" TEXT NOT NULL,
    "protectedTerm" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdNegativeReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdNegativeReview_protectedTerm_campaignId_key" ON "AdNegativeReview"("protectedTerm", "campaignId");
CREATE INDEX "AdNegativeReview_campaignId_idx" ON "AdNegativeReview"("campaignId");
