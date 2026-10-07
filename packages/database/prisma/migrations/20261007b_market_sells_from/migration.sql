-- Step 2 "Sells from" per market (Owner 2026-10-07) — SyncChannelPolicy.sourceLocationCodes: the ordered StockLocation
-- codes one channel and market sells from, for the whole business (a row with no account). The quantity a listing shows
-- is the sum over the list; the order is the order a sale takes stock in. A listing's own
-- ChannelListing.sourceLocationCodes replaces it.
-- Additive only: one new column with an empty default on an existing business-owned table (row security, ownership and
-- scoped keys unchanged). Empty = no list, so with no lists every quantity is worked out exactly as before
-- (each location's syncRoutes decide). NOT NULL with a default, as ChannelListing.sourceLocationCodes (20260721_sc0).

-- AlterTable
ALTER TABLE "SyncChannelPolicy" ADD COLUMN "sourceLocationCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
