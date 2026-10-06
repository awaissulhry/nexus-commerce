-- ADS AUTONOMY W1-6b — an ad group floored ON ITS OWN (a product over its own monthly cap in the ads strategy): the
-- ad-group twin of the campaign's floor columns (Campaign.bidsSuppressedAt / bidsSuppressedFloorCents /
-- bidsSuppressedBy, 20260805_adx_a3_suppression_owner): since when, at which floor, and which engine floored it.
--
-- Additive and nullable: every existing ad group keeps NULL = "not floored on its own", so nothing changes at deploy
-- and no engine reads a value until the budget engine floors an ad group. No new table: AdGroup's ownership, grants and
-- row-level security are unchanged.

-- AlterTable
ALTER TABLE "AdGroup" ADD COLUMN IF NOT EXISTS "bidsSuppressedAt" TIMESTAMP(3);
ALTER TABLE "AdGroup" ADD COLUMN IF NOT EXISTS "bidsSuppressedBy" TEXT;
ALTER TABLE "AdGroup" ADD COLUMN IF NOT EXISTS "bidsSuppressedFloorCents" INTEGER;
