-- HV.3 — where a graduated keyword goes, stored per scope and per match type.
--
-- Additive only: one new table, no existing table altered, nothing backfilled. Ships EMPTY, exactly
-- as AdsHarvestPolicy did — the resolver's shortlist is the default and a row here is an override.
--
-- ── 🔴 WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────
--
-- `applyHarvest` (ads-harvest.service.ts:123) does:
--     const destAdGroupId = args.destinations?.[gm] ?? srcAg?.id
-- and then, at :133:
--     const promotedElsewhere = !!srcAg && gradMatches.some((gm) => {
--       const d = args.destinations?.[gm]; return !!d && d !== srcAg.id })
--     if (promotedElsewhere) { … negateCampaign(…) }        ← the H.3 isolation negative
--
-- So NO destinations map ⇒ the keyword is created back in the ad group that discovered it ⇒
-- `promotedElsewhere` is false ⇒ **the source is never negated**. "Promoted into the source" and
-- "did not negate the source" are ONE defect, not two. Only the SP Super Wizard has ever populated
-- that map; the standalone template and ads-auto-harvest both pass `undefined`.
--
-- ── WHY A SECOND TABLE RATHER THAN A `kind` ROW IN AdsHarvestPolicy ──────────────────────────
--
-- AdsHarvestPolicy is unique on (scopeGrain, scopeId, kind) — ONE row per scope, holding a criteria
-- set. A destination map needs one row per (scope × match type) and carries an ad-group reference
-- plus the create/negate matrix. Forcing it into `kind` would mean either JSON-blobbing the map
-- (unqueryable, and HV.4 has to join it) or inventing `kind = 'dest:EXACT'` — a compound
-- discriminator, which is the same mistake as `AdsRuleSuggestion.proposedKey` being a bare action
-- type with the entity smuggled in beside it.
--
-- ── WHY `matchType` IS PART OF THE KEY ───────────────────────────────────────────────────────
--
-- A source can graduate to more than one match type in one action (`HarvestPlan.graduate` is a
-- string[]), and they go to DIFFERENT ad groups: EXACT to the exact ad group, PHRASE to the phrase
-- one. One row per (scope, matchType) is what `applyHarvest`'s `destinations` map already is.
--
-- ── WHY THE RESOLVER IS NOT THE DEFAULT ──────────────────────────────────────────────────────
--
-- Measured 2026-08-12 across all 289 ad groups (`_hv-3-destination.mts`): resolving "the manual
-- keyword-targeted ad group advertising the same product in the same market, whose role is the
-- match type being created" finds SOMETHING for 287 of 287 sources — but finds exactly ONE for only
-- 38 (13%). Median 5 candidates, max 21. On the 8 shipped candidates, 7 resolve to 2–11 ad groups
-- and one resolves uniquely. Tightening from product-line grain to exact-ASIN grain moves it from
-- 35 to 38 of 287. This account advertises the same ASINs across many overlapping campaigns, so the
-- resolver can only ever produce a RANKED SHORTLIST. The operator picks; this table remembers.

CREATE TABLE "AdsHarvestDestination" (
  "id"         TEXT NOT NULL,
  -- account | market | line | portfolio | campaign | adGroup
  "scopeGrain" TEXT NOT NULL,
  -- '*' for account. NOT nullable, for the reason AdsHarvestPolicy's header gives: Postgres treats
  -- NULLs as DISTINCT inside a unique index, so a nullable key would accept two account rows and
  -- the resolver would pick one arbitrarily.
  "scopeId"    TEXT NOT NULL DEFAULT '*',
  -- EXACT | PHRASE | BROAD | PRODUCT — the target type being CREATED, which is also the key of
  -- applyHarvest's `destinations` map.
  "matchType"  TEXT NOT NULL,

  -- The chosen destination. AdGroup.id, not an external id: applyHarvest's map holds local ids.
  "adGroupId"  TEXT NOT NULL,

  -- The create/negate matrix for this scope, in the same shape the SP Super Wizard already uses
  -- (RuleRowSel at campaign-builder/sp-super-wizard/LaunchStep.tsx:34), so it maps 1:1 onto
  -- HarvestPlan without a second vocabulary.
  "negateAtSource" BOOLEAN NOT NULL DEFAULT true,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  -- A destination decides where money goes. An unattributable one is the class of row this
  -- programme has twice had to reverse-engineer from a cron summary.
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "AdsHarvestDestination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdsHarvestDestination_scopeGrain_scopeId_matchType_key"
  ON "AdsHarvestDestination"("scopeGrain", "scopeId", "matchType");

CREATE INDEX "AdsHarvestDestination_adGroupId_idx"
  ON "AdsHarvestDestination"("adGroupId");
