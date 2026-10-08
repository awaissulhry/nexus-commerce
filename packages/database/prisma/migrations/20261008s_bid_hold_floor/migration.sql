-- BID BRAIN #513 follow-up — a STOP hold's declared floor in its own column (it was the head of `reason`).
-- Additive: nullable, no default; rows written before keep the floor in their reason, which the code still reads.
ALTER TABLE "BidHold" ADD COLUMN "floorCents" INTEGER;
