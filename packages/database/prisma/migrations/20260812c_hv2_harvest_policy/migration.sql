-- HV.2 — the graduation thresholds become a stored, attributable policy.
--
-- Additive only: one new table, no existing table altered, nothing backfilled.
--
-- WHAT THIS REPLACES. The thresholds live today as two constants in a service file with no UI
-- anywhere: `ads-harvest.service.ts:41-42` (DEFAULT_MIN_SPEND_CENTS = 1500, DEFAULT_MIN_ORDERS = 2)
-- and `CONVERTING_MIN_ORDERS` in the evaluator's env. Measured on prod 2026-08-12, the threshold is
-- the single value that decides whether this tab has any content at all:
--   minOrders 1 -> 92 candidates (58 new) · 2 -> 17 (1 new) · 3 -> 8 (0 new)
-- A number with that much leverage and no surface is the defect this table exists to remove.
--
-- 🔴 WHY `scopeId` IS NOT NULLABLE. The account-level row uses the sentinel '*'. Postgres treats
-- NULLs as DISTINCT inside a unique index, so `@@unique([scopeGrain, scopeId, kind])` with a
-- nullable scopeId would happily accept two account rows and the resolver would then pick one
-- arbitrarily — a policy surface whose answer depends on insertion order. The sentinel makes "one
-- row per (grain, id, kind)" a constraint the database enforces rather than a convention the
-- application remembers.
--
-- WHY `kind` EXISTS NOW AND IS ONLY EVER 'graduate' HERE. The wasteful-term negation threshold
-- belongs to Negative Targeting (decision D4; `NegWastefulWords.tsx` is stubbed for it). Adding the
-- discriminator now costs one column and means NEG does not have to migrate this table later;
-- HV.2 never writes a 'negate' row and the page renders no negation control.
--
-- WHY THERE IS NO LATENCY-SKIP COLUMN. Measured 2026-08-12 (`_hv-2a-ingest.mts`, `_hv-2-criteria.mts`):
-- skipping the provisional tail by 0/1/2/3 days leaves the candidate count at 17/17/17/17 at 2+
-- orders and 92/92/92/91 at 1+. It changes nothing, because `ads-report-create-st` requests
-- yesterday() once and never re-requests, so the freshest days carry a seven-day attribution window
-- snapshotted after one day (CVR 0.21% at 0-2 days old vs 2.53% at 8-14) and contribute almost no
-- multi-order terms in the first place. A skip would discard real data to fix nothing. If the
-- ingest is ever repaired to re-request a trailing window, revisit this — do not add the column
-- before the data would move.
--
-- WHY `updatedBy` IS NOT NULL. A threshold is a money decision: it changes what the page proposes
-- for every operator in that scope. An unattributable one is the class of row this programme has
-- twice had to reverse-engineer from a cron summary.

CREATE TABLE "AdsHarvestPolicy" (
  "id"                  TEXT NOT NULL,
  -- account | market | line | portfolio | campaign | adGroup
  "scopeGrain"          TEXT NOT NULL,
  -- '*' for account; marketplace code | Product.id | externalPortfolioId | Campaign.id | AdGroup.id
  "scopeId"             TEXT NOT NULL DEFAULT '*',
  "kind"                TEXT NOT NULL DEFAULT 'graduate',

  "minOrders"           INTEGER NOT NULL,
  "minClicks"           INTEGER NOT NULL,
  -- null = no ceiling. A candidate with orders but NO attributed sales has no ACoS and is KEPT,
  -- never excluded — excluding on a missing measurement is the blank-is-not-a-zero failure.
  "maxAcosPct"          INTEGER,
  "windowDays"          INTEGER NOT NULL,
  -- exclude candidates whose EVERY order arrived via an EXACT match: the harvest read has no
  -- match-type filter, so those rows offer to create the keyword that produced the traffic.
  "excludeExactMatched" BOOLEAN NOT NULL DEFAULT true,

  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  "updatedBy"           TEXT NOT NULL,

  CONSTRAINT "AdsHarvestPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdsHarvestPolicy_scopeGrain_scopeId_kind_key"
  ON "AdsHarvestPolicy"("scopeGrain", "scopeId", "kind");

CREATE INDEX "AdsHarvestPolicy_kind_scopeGrain_idx"
  ON "AdsHarvestPolicy"("kind", "scopeGrain");
