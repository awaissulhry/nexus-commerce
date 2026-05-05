-- E.9 — Refine the E.1 backfill of VariantChannelListing.marketplace.
--
-- The E.1 migration set marketplace to alphabetic MIN() of the product's
-- ChannelListing marketplaces. For sellers whose primary marketplace is
-- not alphabetically first (e.g. Xavia → IT, but products listed on IT
-- and DE would have backfilled to DE), the existing single VCL row got
-- tagged with the wrong marketplace.
--
-- This follow-up corrects that bias by preferring 'IT' (Xavia's primary)
-- when both:
--   1. the row is on AMAZON channel
--   2. a sibling AMAZON:IT ChannelListing exists for the same product
--   3. the row's current marketplace is NOT 'IT'
--   4. the row hasn't been synced since (lastSyncedAt IS NULL — proxy for
--      "never touched after the original backfill")
--
-- Idempotent: re-running on data that's already correct is a no-op. Safe
-- to apply alongside ongoing publish/sync activity because the
-- lastSyncedAt guard skips any row a real sync has touched.
--
-- Future TECH_DEBT: the "primary marketplace" should be a per-seller
-- setting (some Nexus tenants will have DE or US primary). Hardcoded to
-- 'IT' here because Xavia is the live tenant and writing the seller-
-- preferences table is out of scope for this fix.

UPDATE "VariantChannelListing" vcl
SET "marketplace" = 'IT'
FROM "ProductVariation" pv
WHERE vcl."variantId" = pv.id
  AND vcl.channel = 'AMAZON'
  AND vcl.marketplace != 'IT'
  AND vcl."lastSyncedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "ChannelListing" cl
    WHERE cl."productId" = pv."productId"
      AND cl.channel = 'AMAZON'
      AND cl.marketplace = 'IT'
  );
