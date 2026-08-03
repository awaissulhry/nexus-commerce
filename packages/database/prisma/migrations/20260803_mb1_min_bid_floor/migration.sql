-- MB.1 — a Min-bid target's floor becomes data instead of a module constant.
--
-- Purely additive: two nullable columns, no backfill, no default. NULL carries the exact
-- meaning the code had before this migration — RankTarget.floorBidCents NULL = the legacy
-- 2¢ SUPPRESSION_FLOOR_CENTS, and Campaign.bidsSuppressedFloorCents NULL = "suppressed
-- before MB.1, therefore at 2¢". Every live schedule keeps its current behaviour until an
-- operator sets a number, so this can deploy ahead of the UI that writes it.

ALTER TABLE "RankTarget" ADD COLUMN "floorBidCents" INTEGER;

ALTER TABLE "Campaign" ADD COLUMN "bidsSuppressedFloorCents" INTEGER;
