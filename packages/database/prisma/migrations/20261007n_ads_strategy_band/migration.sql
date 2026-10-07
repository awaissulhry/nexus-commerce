-- BID BRAIN BB-5 — the ads strategy's target band (design BID-BRAIN-DESIGN.md §4, Owner decision 2026-10-07: a range
-- aiming at the target). Additive only: two nullable integer-percent columns on AdsStrategy, part of the target group.
-- With both empty every row reads exactly as before; the bid brain (shadow) stands −10 % / +15 % around targetPct in.
-- No policy change: AdsStrategy keeps its row-level security.

-- AlterTable
ALTER TABLE "AdsStrategy" ADD COLUMN     "targetHiPct" INTEGER,
ADD COLUMN     "targetLoPct" INTEGER;
