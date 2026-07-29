-- AX3.4 — record a replication that had no saved blueprint behind it.
--
-- AdBlueprintApplication.blueprintId was NOT NULL, which forced every run to be
-- preceded by a saved AdBlueprint. The replication builder plans straight from a
-- live source — a portfolio, some campaigns, or single ad groups — and saving a
-- blueprint is an explicit, optional action at the end. Without this, an
-- ephemeral run either could not be recorded at all (no audit trail, no
-- rollback unit) or had to silently create a throwaway blueprint per run.
--
-- ADDITIVE and reversible in effect: every existing row keeps its blueprintId,
-- and the read paths already treat the column as an optional filter. Nothing is
-- dropped, renamed or backfilled.
--
--   blueprintId    -> nullable; null = replicated straight from a live source
--   sourceSelector -> WHAT was replicated (portfolioId / campaignIds /
--                     adGroupIds / namePrefix + the source marketplace), so a
--                     run can be explained and repeated after the fact
--   options        -> the naming rules, copy scope and bid/budget policies the
--                     operator chose; without these "why is this campaign called
--                     that" is unanswerable a month later
--   edits          -> the step-2 edit set actually applied
--   launchMode     -> 'live' | 'floor'. AX3.5 lets a run land at Amazon's 2c bid
--                     floor instead of the planned bids; which one was chosen is
--                     a money fact and belongs on the record, not in a log line.

ALTER TABLE "AdBlueprintApplication" ALTER COLUMN "blueprintId" DROP NOT NULL;
ALTER TABLE "AdBlueprintApplication" ADD COLUMN IF NOT EXISTS "sourceSelector" JSONB;
ALTER TABLE "AdBlueprintApplication" ADD COLUMN IF NOT EXISTS "options" JSONB;
ALTER TABLE "AdBlueprintApplication" ADD COLUMN IF NOT EXISTS "edits" JSONB;
ALTER TABLE "AdBlueprintApplication" ADD COLUMN IF NOT EXISTS "launchMode" TEXT;
