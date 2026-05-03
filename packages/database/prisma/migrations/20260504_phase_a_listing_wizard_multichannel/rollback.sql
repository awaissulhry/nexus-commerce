-- Reverse of 20260504_phase_a_listing_wizard_multichannel.
--
-- Drops new structures + restores the single-channel columns.
-- Multi-channel wizards (where channels has > 1 entry) collapse to
-- the FIRST channel — destructive but reversible by intent.

BEGIN;

-- ── 1. Restore old columns nullable ────────────────────────────────
ALTER TABLE "ListingWizard"
  ADD COLUMN IF NOT EXISTS "channel"     TEXT,
  ADD COLUMN IF NOT EXISTS "marketplace" TEXT;

-- ── 2. Backfill from the first entry of channels[] ─────────────────
DO $$
DECLARE
  v_has_channels_col BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ListingWizard' AND column_name = 'channels'
  ) INTO v_has_channels_col;

  IF v_has_channels_col THEN
    UPDATE "ListingWizard"
    SET
      "channel"     = "channels" -> 0 ->> 'platform',
      "marketplace" = "channels" -> 0 ->> 'marketplace'
    WHERE "channel" IS NULL AND jsonb_array_length("channels") >= 1;
  END IF;
END $$;

ALTER TABLE "ListingWizard"
  ALTER COLUMN "channel"     SET NOT NULL,
  ALTER COLUMN "marketplace" SET NOT NULL;

-- ── 3. Drop new unique + columns ───────────────────────────────────
ALTER TABLE "ListingWizard"
  DROP CONSTRAINT IF EXISTS "ListingWizard_productId_channelsHash_status_key";

DROP INDEX IF EXISTS "ListingWizard_productId_idx";

ALTER TABLE "ListingWizard"
  DROP COLUMN IF EXISTS "channels",
  DROP COLUMN IF EXISTS "channelsHash",
  DROP COLUMN IF EXISTS "channelStates",
  DROP COLUMN IF EXISTS "submissions";

-- ── 4. Restore old composite index ─────────────────────────────────
CREATE INDEX IF NOT EXISTS "ListingWizard_productId_channel_marketplace_idx"
  ON "ListingWizard" ("productId", "channel", "marketplace");

-- ── 5. Drop ListingImage + enums ───────────────────────────────────
DROP TABLE IF EXISTS "ListingImage";
DROP TYPE  IF EXISTS "ImageRole";
DROP TYPE  IF EXISTS "ImageScope";

COMMIT;
