-- 20260504_phase_a_listing_wizard_multichannel
--
-- Major architectural shift: ListingWizard moves from single-channel
-- (channel + marketplace columns) to multi-channel (channels JSON
-- array + per-channel state/submissions). New ListingImage table for
-- multi-scope per-listing image management with variation support.
--
-- Idempotent throughout. Safe to rerun. Backfill is staged:
--   1. ADD nullable columns
--   2. UPDATE to backfill from old (channel, marketplace)
--   3. ALTER to NOT NULL where required
--   4. DROP old columns + old index
--   5. ADD new unique constraint
--   6. CREATE new ListingImage table + enums
--
-- See rollback.sql for the reverse path.

BEGIN;

-- ── 1. Add new ListingWizard columns (nullable for staged backfill) ─
ALTER TABLE "ListingWizard"
  ADD COLUMN IF NOT EXISTS "channels"      JSONB,
  ADD COLUMN IF NOT EXISTS "channelsHash"  TEXT,
  ADD COLUMN IF NOT EXISTS "channelStates" JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "submissions"   JSONB DEFAULT '[]'::jsonb;

-- ── 2. Backfill from existing single-channel rows ──────────────────
-- Single-channel rows become single-entry channels arrays. The hash
-- algorithm (md5 of "PLATFORM:MARKET") matches what the API will use
-- for new rows in Phase B onward. Defensive guards: only run on rows
-- that haven't been backfilled yet AND still have the old columns
-- present (the second check matters if this migration is re-applied
-- after the DROP COLUMN below — we use information_schema instead of
-- a WHERE on the column to keep the statement valid post-drop).
DO $$
DECLARE
  v_has_channel_col BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ListingWizard' AND column_name = 'channel'
  ) INTO v_has_channel_col;

  IF v_has_channel_col THEN
    UPDATE "ListingWizard"
    SET
      "channels" = jsonb_build_array(
        jsonb_build_object('platform', "channel", 'marketplace', "marketplace")
      ),
      "channelsHash"  = md5("channel" || ':' || "marketplace"),
      "channelStates" = COALESCE("channelStates", '{}'::jsonb),
      "submissions"   = COALESCE("submissions",   '[]'::jsonb)
    WHERE "channels" IS NULL;
  END IF;
END $$;

-- ── 3. Make new columns NOT NULL ───────────────────────────────────
-- Only safe after every row has been backfilled above. If the table is
-- empty (which it likely is on dev), this still passes.
ALTER TABLE "ListingWizard"
  ALTER COLUMN "channels"      SET NOT NULL,
  ALTER COLUMN "channelsHash"  SET NOT NULL,
  ALTER COLUMN "channelStates" SET NOT NULL,
  ALTER COLUMN "channelStates" SET DEFAULT '{}'::jsonb,
  ALTER COLUMN "submissions"   SET NOT NULL,
  ALTER COLUMN "submissions"   SET DEFAULT '[]'::jsonb;

-- ── 4. Drop old single-channel columns + index ─────────────────────
DROP INDEX IF EXISTS "ListingWizard_productId_channel_marketplace_idx";

ALTER TABLE "ListingWizard"
  DROP COLUMN IF EXISTS "channel",
  DROP COLUMN IF EXISTS "marketplace";

-- ── 5. New unique resume key ───────────────────────────────────────
-- A wizard is uniquely resumable by (product, channels-set, status).
-- Two DRAFTs for the same product targeting [AMAZON:IT] and
-- [AMAZON:IT, AMAZON:DE] are different rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ListingWizard_productId_channelsHash_status_key'
  ) THEN
    ALTER TABLE "ListingWizard"
      ADD CONSTRAINT "ListingWizard_productId_channelsHash_status_key"
      UNIQUE ("productId", "channelsHash", "status");
  END IF;
END $$;

-- Index productId on its own — speeds the "any wizards for this product"
-- lookups that don't filter by channelsHash.
CREATE INDEX IF NOT EXISTS "ListingWizard_productId_idx"
  ON "ListingWizard" ("productId");

-- ── 6. New ListingImage table + enums ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImageScope') THEN
    CREATE TYPE "ImageScope" AS ENUM ('GLOBAL', 'PLATFORM', 'MARKETPLACE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImageRole') THEN
    CREATE TYPE "ImageRole" AS ENUM (
      'MAIN', 'GALLERY', 'INFOGRAPHIC', 'LIFESTYLE', 'SIZE_CHART', 'SWATCH'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ListingImage" (
  "id"                   TEXT PRIMARY KEY,
  "productId"            TEXT NOT NULL,
  "variationId"          TEXT,

  "scope"                "ImageScope" NOT NULL DEFAULT 'GLOBAL',
  "platform"             TEXT,
  "marketplace"          TEXT,

  "url"                  TEXT NOT NULL,
  "filename"             TEXT,
  "position"             INTEGER NOT NULL,
  "role"                 "ImageRole" NOT NULL DEFAULT 'GALLERY',

  "width"                INTEGER,
  "height"               INTEGER,
  "fileSize"             INTEGER,
  "mimeType"             TEXT,
  "hasWhiteBackground"   BOOLEAN,

  "sourceProductImageId" TEXT,

  "uploadedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploadedBy"           TEXT,

  CONSTRAINT "ListingImage_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE,
  CONSTRAINT "ListingImage_variationId_fkey"
    FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "ListingImage_productId_scope_platform_marketplace_idx"
  ON "ListingImage" ("productId", "scope", "platform", "marketplace");

CREATE INDEX IF NOT EXISTS "ListingImage_productId_variationId_scope_idx"
  ON "ListingImage" ("productId", "variationId", "scope");

CREATE INDEX IF NOT EXISTS "ListingImage_productId_position_idx"
  ON "ListingImage" ("productId", "position");

-- ── 7. Soft sanity check (raises NOTICE, doesn't fail) ─────────────
DO $$
DECLARE
  v_total INT;
  v_backfilled INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM "ListingWizard";
  SELECT COUNT(*) INTO v_backfilled FROM "ListingWizard"
    WHERE jsonb_array_length("channels") = 1;
  RAISE NOTICE 'ListingWizard: % total rows, % single-channel-backfilled', v_total, v_backfilled;
END $$;

COMMIT;
