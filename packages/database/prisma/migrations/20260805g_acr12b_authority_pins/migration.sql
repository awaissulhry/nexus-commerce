-- ACR.1.2b — per-dimension authority pins on Campaign.
--
-- "Hands off placement / bids / budget", per campaign, enforced at ads-write-gate.ts
-- beside the existing entity bid bounds. Additive and default-FALSE, so every existing
-- row keeps exactly today's behaviour until an operator pins something.
--
-- The bounds say how far automation may move a number; these say whether it may touch
-- that number at all. On the entity rather than in a rule for the same reason
-- minBidCents/maxBidCents are: the gate is the single door to Amazon, so a column binds
-- every engine automatically — including ones written next year.
ALTER TABLE "Campaign" ADD COLUMN "pinPlacement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "pinBids" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "pinBudget" BOOLEAN NOT NULL DEFAULT false;

-- Accountability for the pin itself. A pin found later with no author is
-- indistinguishable from a bug.
ALTER TABLE "Campaign" ADD COLUMN "pinnedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "pinnedBy" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "pinNote" TEXT;
