-- APS.1 — give ProductReadCache the two facts the ads product picker needs.
-- Purely additive: no column is dropped, retyped, or has its meaning changed.
--
-- WHY (all measured on prod 2026-07-30, harnesses apps/api/scripts/_ps-leak-probe*.mts):
--
--  · "asin" — the picker rendered an Amazon badge beside a SKU and presented it
--    as an ASIN, because /api/products/search never returned one. Product ads,
--    SB creatives (ads-create.service.ts throws "at least one ASIN required")
--    and product targets all need the real value. Product.amazonAsin is already
--    populated on 246/339 products; the cache simply never mirrored it.
--
--  · "rollupChannelKeys" — channelKeys is built from a row's OWN ChannelListings
--    (product-read-cache.service.ts, where: { productId }). A variation parent
--    therefore looks unlisted even when its children are live. Measured:
--    normal-knee-slider has channelKeys=['EBAY_IT'] and EIGHT children on
--    Amazon. Scoping the picker on channelKeys would have hidden a family with
--    8 advertisable ASINs — under-showing instead of over-showing.
--
--    So this is a SEPARATE column, not a redefinition of channelKeys. The
--    /products grid's marketplace facet keeps filtering on channelKeys and is
--    provably unaffected; only marketplace-scoped pickers read the rollup.
--
-- Both columns are backfilled by apps/api/scripts/_aps1-backfill.mts and
-- maintained thereafter by refreshProductReadCache().

ALTER TABLE "ProductReadCache" ADD COLUMN IF NOT EXISTS "asin" TEXT;

ALTER TABLE "ProductReadCache"
  ADD COLUMN IF NOT EXISTS "rollupChannelKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS "ProductReadCache_asin_idx"
  ON "ProductReadCache" ("asin");

-- hasSome / && over a text[] — same access shape as categoryIds.
CREATE INDEX IF NOT EXISTS "ProductReadCache_rollupChannelKeys_idx"
  ON "ProductReadCache" USING GIN ("rollupChannelKeys");
