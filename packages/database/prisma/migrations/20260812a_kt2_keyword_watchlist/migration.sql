-- KT.2 — the Keyword Tracker's watchlist becomes a real object, per market.
--
-- Additive only: two new tables, no existing table altered, nothing backfilled by this migration.
-- The four lists are seeded by `apps/api/scripts/_kt2-seed-watchlists.mts` (idempotent) so the
-- seed is a measurement decision with a script behind it, not an opaque INSERT in a migration.
--
-- 🔴 Why a new entity instead of reusing KeywordCoverageSet, which already holds 97 curated terms:
-- that table is the ACR coverage engine's arming switch, not a list. Measured on prod 2026-08-12:
--   · `ads-coverage-engine.service.ts:172` selects `{ enabled: true }` sets and, at
--     NEXUS_COVERAGE_ENGINE_MODE=auto, steps their keyword bids through `updateAdTargetWithSync`
--     — the real write path to Amazon;
--   · that engine is scheduled daily at 07:10 (`ads-sync.job.ts:798`) and has RUN six nights,
--     each `mode=observe sets=0` — it writes nothing today only because the one set is disabled;
--   · all 97 of that set's terms already carry a `leadAsin`, which is the engine's precondition
--     for acting on a term;
--   · `PATCH /advertising/coverage-sets/:id { enabled }` is wired to a button on the Family
--     Cockpit page.
-- So one UI toggle starts nightly evaluation and one env var turns it into bid writes. A page for
-- watching keywords must not share a table with that, and this one carries no `enabled` column.
--
-- Why per-market and not one list with a market column on the terms: the defect being fixed is
-- that `keyword-tracker.service.ts` fell back to `sets[0]` and served 97 Italian terms to DE, ES
-- and FR. Measured: only 8 of those 97 have ever had a DE row, 3 an ES row, 3 an FR row — so
-- DE/ES/FR's near-empty grids were a wrong-list artefact, not a data gap. The unique index on
-- (marketplace, name) makes "one market's list" the unit the schema enforces.

-- CreateTable
CREATE TABLE "KeywordWatchlist" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordWatchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordWatchlistTerm" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "isBranded" BOOLEAN NOT NULL DEFAULT false,
    "addedFrom" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeywordWatchlistTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KeywordWatchlist_marketplace_name_key" ON "KeywordWatchlist"("marketplace", "name");

-- CreateIndex — the page's first query is "the default list for this market"
CREATE INDEX "KeywordWatchlist_marketplace_isDefault_idx" ON "KeywordWatchlist"("marketplace", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordWatchlistTerm_watchlistId_term_key" ON "KeywordWatchlistTerm"("watchlistId", "term");

-- CreateIndex — branded terms are excluded by default, so the filter is on the hot path
CREATE INDEX "KeywordWatchlistTerm_watchlistId_isBranded_idx" ON "KeywordWatchlistTerm"("watchlistId", "isBranded");

-- AddForeignKey — CASCADE: deleting a list must take its terms, and a term has no meaning alone.
ALTER TABLE "KeywordWatchlistTerm" ADD CONSTRAINT "KeywordWatchlistTerm_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "KeywordWatchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
