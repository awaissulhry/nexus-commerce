-- ADS AUTONOMY AA-W2-2b — Claude's daily limits per market in the ads strategy (Owner decision D-W2-3): the most changes,
-- raises and budget increase (minor units of the market's currency) Claude's ad changes may add in one market in 24
-- hours when they run by the business's rule. MARKET rows only (the writer refuses them on a category or product row).
--
-- Additive and nullable: every existing row keeps NULL, which the readers take as 0 — nothing that adds to a limit runs
-- by rule in that market until the Owner sets one (a raise needs his authenticator code). No ad change runs by rule
-- today, so nothing changes at deploy. No new table: AdsStrategy's ownership, grants and row-level security are
-- unchanged.

-- AlterTable
ALTER TABLE "AdsStrategy" ADD COLUMN IF NOT EXISTS "claudeMaxChangesPerDay" INTEGER;
ALTER TABLE "AdsStrategy" ADD COLUMN IF NOT EXISTS "claudeMaxRaisesPerDay" INTEGER;
ALTER TABLE "AdsStrategy" ADD COLUMN IF NOT EXISTS "claudeMaxBudgetIncreasePerDayCents" INTEGER;
