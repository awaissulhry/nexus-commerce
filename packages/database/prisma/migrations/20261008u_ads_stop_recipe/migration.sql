-- ONE BRAIN AB-2 — the stop recipe's memory on a campaign the bid brain owns: the placement % live when a stop (or a
-- Min-bid hour) set every lane to 0 %, and the bidding strategy it switched from (up and down → down only for the stop).
-- Additive: two nullable columns, no default; every existing row reads as "no stop holds the lanes or the strategy".
ALTER TABLE "Campaign" ADD COLUMN "suppressedFromPlacements" JSONB;
ALTER TABLE "Campaign" ADD COLUMN "suppressedFromBiddingStrategy" "BiddingStrategy";
