-- RS.1.1 — "all-out" defend mode on a rank target (ignore ACOS cap, hold at any
-- cost up to maxCpcCents). Fully additive.

ALTER TABLE "RankTarget" ADD COLUMN "allOut" BOOLEAN NOT NULL DEFAULT false;
