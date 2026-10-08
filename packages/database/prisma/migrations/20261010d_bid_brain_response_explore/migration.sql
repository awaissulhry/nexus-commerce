-- BID BRAIN BB-20 — the explore budget per market and day in the ads strategy (additive: one nullable column, no default,
-- no row changes). Empty reads as the Owner's default (200 in IT, 100 in DE, none elsewhere); 0 switches exploration off.
-- AdsStrategy is already classified (business-owned) with its row-level policy; a new column needs no grant of its own.
ALTER TABLE "AdsStrategy" ADD COLUMN "exploreBudgetCents" INTEGER;
