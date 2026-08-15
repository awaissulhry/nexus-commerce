-- BUD.2 -- the budget baseline and bounds. Purely additive: three nullable columns, nothing
-- altered, nothing dropped; NULL keeps every existing row's behaviour exactly.
--
-- budgetBaselineCents: the anchor RELATIVE budget rules compute from. The ratchet (-15%/-20%
-- of the CURRENT value per tick, no cooldown) walked GALE EXACT DE from EUR 100 to EUR 1 in 39
-- writes in a day; anchored to a baseline the same rule is idempotent -- -20% of EUR 100 is
-- EUR 80 on every tick. NULL = no anchor captured; handlers use the current value as before.
--
-- minBudgetCents / maxBudgetCents: gate-enforced beside minBidCents/maxBidCents on the same
-- read -- a cut below the floor or a raise above the ceiling is DENIED, never clamped, for
-- every engine and rule, because ads-write-gate.ts is the only way to Amazon.
ALTER TABLE "Campaign" ADD COLUMN "budgetBaselineCents" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN "minBudgetCents" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN "maxBudgetCents" INTEGER;
