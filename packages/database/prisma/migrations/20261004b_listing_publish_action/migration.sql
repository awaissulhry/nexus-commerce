-- Sheet publish parity, build shape v2 (2026-10-04; plan docs/sheet-publish-parity/PLAN.md, "BUILD SHAPE v2", phase P2).
--
-- Every channel scope of the product sheet gets two columns, one value per market, that WAIT on the listing row until
-- Publish sends them (`@nexus/shared/publish-actions`):
--   - Action: how Publish sends the content. FULL_UPDATE or DELETE; null = Partial update (today's Publish, the default).
--   - Status: the selling state to reach. ACTIVE, INACTIVE or ENDED; null = no change waiting.
-- Each column keeps who set it and when. The `…At` column is the compare-and-set guard of a write (the sheet sends the
-- value it saw; a different stored value is a conflict that names who changed it). `publishActionBasis` keeps what the
-- row was when a value was set (selling state and channel id), so a value the listing has outgrown can say
-- "No longer applies".
--
-- Additive only: seven nullable columns on an existing business-owned table (ChannelListing is already classified in
-- workspaces/model-ownership.json; its row-level security covers every column), and two CHECK constraints that hold
-- the two text columns to their words. Nothing existing is read differently; every existing row stays null (Partial
-- update, nothing waiting).

-- AlterTable
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "publishAction" TEXT,
ADD COLUMN IF NOT EXISTS "publishActionAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "publishActionBasis" JSONB,
ADD COLUMN IF NOT EXISTS "publishActionById" TEXT,
ADD COLUMN IF NOT EXISTS "sellingTarget" TEXT,
ADD COLUMN IF NOT EXISTS "sellingTargetAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sellingTargetById" TEXT;

-- ── Values ──────────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChannelListing_publishAction_check') THEN
    ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_publishAction_check"
      CHECK ("publishAction" IS NULL OR "publishAction" IN ('FULL_UPDATE', 'DELETE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChannelListing_sellingTarget_check') THEN
    ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_sellingTarget_check"
      CHECK ("sellingTarget" IS NULL OR "sellingTarget" IN ('ACTIVE', 'INACTIVE', 'ENDED'));
  END IF;
END $$;
