-- ACR.0.5 — true profit must be able to say "unknown".
--
-- Both columns were `Int NOT NULL DEFAULT 0`, so the schema had no way to express the one
-- thing that is actually true today: XAVIA has no cost price loaded for any product
-- (measured 2026-08-05 — costPrice null on 362/362, weightedAvgCostCents 240 null /
-- 122 zero / 0 real). With cogsCents = 0 the formula
--     revenue − COGS − fees − adSpend − returns
-- collapses to revenue-minus-fees, which is the most flattering number it can produce, and
-- the console rendered it as "True profit". A read-side guard alone could not fix that: the
-- wrong number was already stored, and `coverage.hasCostPrice` was itself written true for
-- rows whose cost was a zero.
--
-- Nullable + repair. Every input component (revenue, cogs, each fee, ad spend, returns) is
-- still stored, so every one of these rows recomputes exactly when COGS lands.

-- 1. Let the columns hold "unknown".
ALTER TABLE "ProductProfitDaily" ALTER COLUMN "trueProfitCents" DROP NOT NULL;
ALTER TABLE "ProductProfitDaily" ALTER COLUMN "trueProfitCents" DROP DEFAULT;
ALTER TABLE "Campaign"          ALTER COLUMN "trueProfitCents" DROP NOT NULL;
ALTER TABLE "Campaign"          ALTER COLUMN "trueProfitCents" DROP DEFAULT;

-- 2. Repair ProductProfitDaily. "Cost unknown" is cogsCents = 0 against real revenue —
--    zero units sold legitimately costs zero, so rows without revenue are left alone.
--    coverage.hasCostPrice is rewritten from the row itself rather than trusted, because
--    it was set true for the 122 products whose weightedAvgCostCents was literally 0.
UPDATE "ProductProfitDaily"
   SET "coverage" = jsonb_set(COALESCE("coverage", '{}'::jsonb), '{hasCostPrice}', 'false'::jsonb),
       "trueProfitCents" = NULL,
       "trueProfitMarginPct" = NULL
 WHERE "cogsCents" <= 0
   AND "grossRevenueCents" > 0;

-- 3. Repair Campaign. No code path has ever written these two columns (verified by grep
--    2026-08-05: 216/216 rows carried trueProfitCents = 0 and trueProfitMarginPct = NULL),
--    so the 0 was the column default being read as a measurement. Scoped to exactly that
--    never-computed shape so it stays correct if a writer is added later.
UPDATE "Campaign"
   SET "trueProfitCents" = NULL
 WHERE "trueProfitCents" = 0
   AND "trueProfitMarginPct" IS NULL;
