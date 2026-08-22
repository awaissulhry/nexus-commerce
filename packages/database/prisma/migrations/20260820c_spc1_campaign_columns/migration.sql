-- SPC.1 — the 27 fields that let spCampaigns go from 10 requested / 8 stored to 38 / 35.
--
-- Purely additive: 27 nullable columns with NO DEFAULT. A nullable ADD COLUMN
-- without a default is a catalogue-only change in Postgres — no table rewrite, so
-- this is instant on the 50,141 rows here and stays instant as the table grows.
--
-- 🔴 NO `DEFAULT 0` on any of them, deliberately. The four existing `sales*Cents`
-- columns carry `@default(0)`, and that is exactly why 1d/14d/30d were unreadable:
-- nothing ever requested them, every row said 0, and 0 is also the right answer for
-- a campaign-day that sold nothing. Measured before writing this: all three hold
-- ONE distinct value across all 50,141 rows. NULL now means "not requested for this
-- row" and 0 means "Amazon said zero".
--
-- 🔴 `IF NOT EXISTS` on every statement. A hand-applied column meeting a bare
-- `ADD COLUMN` on the next deploy raises 42701, which fails the migration and
-- blocks EVERY later deploy service-wide with P3009.

-- The other three attribution windows, as counts (the sales side already existed).
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "orders1d"  INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "orders14d" INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "orders30d" INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "units1d"   INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "units14d"  INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "units30d"  INTEGER;

-- Same-SKU attribution. Halo is derived at read time as (total - sameSku); Amazon
-- offers no otherSku column at campaign grain.
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "salesSameSku1dCents"  INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "salesSameSku7dCents"  INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "salesSameSku14dCents" INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "salesSameSku30dCents" INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "ordersSameSku1d"      INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "ordersSameSku7d"      INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "ordersSameSku14d"     INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "ordersSameSku30d"     INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "unitsSameSku1d"       INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "unitsSameSku7d"       INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "unitsSameSku14d"      INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "unitsSameSku30d"      INTEGER;

-- Amazon's own top-of-search impression share at this grain. Same type as the
-- placement table's, so the two can never disagree about precision.
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "topOfSearchIS" DECIMAL(8,4);

-- The campaign's configuration as it was on that day, which rides in free.
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "campaignBudgetCents"          INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "campaignBudgetType"           TEXT;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "campaignBiddingStrategy"      TEXT;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "campaignRuleBasedBudgetCents" INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "campaignBudgetRuleId"         TEXT;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "campaignBudgetRuleName"       TEXT;

-- The name and status Amazon has been sending all along and we threw away.
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "entityName"   TEXT;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "entityStatus" TEXT;
