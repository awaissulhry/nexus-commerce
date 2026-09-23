-- PLAN A-39 (R-41) — Step 3.5b slice b1: a per-source clock on ChannelDrift.
-- Additive only: one new column with a default; every existing row reads '{}' ("no source has a clock yet"), and no
-- existing reader changes behaviour. The table's row-level security is unchanged (a column needs no policy).

-- AlterTable
ALTER TABLE "ChannelDrift" ADD COLUMN "checkedBySource" JSONB NOT NULL DEFAULT '{}';
