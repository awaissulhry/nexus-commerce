-- E.1 — VariantChannelListing per-marketplace identity
--
-- Why this migration: today VariantChannelListing keys on (variantId, channelId) where
-- channelId is the legacy Channel.id reference. The "marketplace" axis has never been
-- on this table — meaning a single child SKU on AMAZON can only carry ONE per-channel
-- record (one channelProductId / channelSku / per-channel price), no matter how many
-- Amazon marketplaces it's listed in. The architecture audit (E.0) confirms the user's
-- model requires per-marketplace child ASINs and SKUs, so this column must be added
-- and the uniqueness reshaped around (variantId, channel, marketplace).
--
-- Same migration also adds composite indexes the audit identified as performance hot
-- paths once 16K+ ChannelListing rows land:
--   - VariantChannelListing(channel, marketplace, listingStatus)
--   - ChannelListing(channel, marketplace, listingStatus)
--
-- Migration discipline (TECH_DEBT #37/#38):
--   * No `IF NOT EXISTS` boilerplate on CREATE — silent-on-collision is what hid the
--     Return-table drift on 2026-05-05.
--   * Each step is its own ALTER so failures are loud and pinpointable.
--   * Backfill runs BEFORE the NOT NULL flip, so we never have a window of inconsistent
--     data.

-- ─── Step 1: Add the column nullable so backfill can run ──────────────────────
ALTER TABLE "VariantChannelListing"
  ADD COLUMN "marketplace" TEXT;

-- ─── Step 2: Backfill from related ChannelListing where possible ──────────────
-- For each VariantChannelListing row, find a ChannelListing on the same product +
-- channel and copy its marketplace. When the variant's product has multiple
-- ChannelListings on the same channel (e.g., a product listed on both AMAZON:IT
-- and AMAZON:DE), pick the lexicographically lowest marketplace code so the result
-- is deterministic. This produces one VCL per pre-existing row; net-new rows for
-- the other marketplaces are created on demand by the wizard / sync paths.
UPDATE "VariantChannelListing" vcl
SET "marketplace" = sub."marketplace"
FROM (
  SELECT
    pv.id AS variant_id,
    cl.channel AS channel,
    MIN(cl.marketplace) AS marketplace
  FROM "ProductVariation" pv
  JOIN "ChannelListing" cl ON cl."productId" = pv."productId"
  GROUP BY pv.id, cl.channel
) sub
WHERE vcl."variantId" = sub.variant_id
  AND vcl.channel = sub.channel
  AND vcl."marketplace" IS NULL;

-- ─── Step 3: Channel-specific defaults for any rows still NULL ────────────────
-- After step 2 anything still NULL had no matching ChannelListing — these are
-- typically eBay rows pinned to a ChannelConnection that pre-dates ChannelListing
-- coverage, or net-new rows from older sync flows. Default by channel type:
--   * AMAZON  → IT  (Xavia primary; can be reassigned manually)
--   * EBAY    → IT  (Xavia primary; eBay sites resolve via ChannelConnection)
--   * SHOPIFY / WOOCOMMERCE / ETSY → GLOBAL
--   * NULL channel or anything else → GLOBAL
UPDATE "VariantChannelListing"
SET "marketplace" = CASE
  WHEN channel IN ('AMAZON', 'EBAY') THEN 'IT'
  ELSE 'GLOBAL'
END
WHERE "marketplace" IS NULL;

-- ─── Step 4: Lock the column down ─────────────────────────────────────────────
ALTER TABLE "VariantChannelListing"
  ALTER COLUMN "marketplace" SET NOT NULL,
  ALTER COLUMN "marketplace" SET DEFAULT 'GLOBAL';

-- ─── Step 5: New uniqueness on (variantId, channel, marketplace) ──────────────
-- Old (variantId, channelId) unique stays in place — channelId is legacy/nullable
-- and harmless. The new constraint is what the application path enforces.
CREATE UNIQUE INDEX "VariantChannelListing_variantId_channel_marketplace_key"
  ON "VariantChannelListing" ("variantId", "channel", "marketplace");

-- ─── Step 6: Hot-path composite indexes ───────────────────────────────────────
CREATE INDEX "VariantChannelListing_channel_marketplace_listingStatus_idx"
  ON "VariantChannelListing" ("channel", "marketplace", "listingStatus");

CREATE INDEX "VariantChannelListing_marketplace_idx"
  ON "VariantChannelListing" ("marketplace");

CREATE INDEX "ChannelListing_channel_marketplace_listingStatus_idx"
  ON "ChannelListing" ("channel", "marketplace", "listingStatus");
