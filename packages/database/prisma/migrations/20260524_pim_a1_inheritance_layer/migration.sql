-- PIM A.1 — Inheritance layer foundation.
--
-- Adds two JSONB columns + GIN indexes to support the attribute-resolver
-- merge model (master → variant → channel-override → explicit-override).
--
-- Pure additive: no existing column altered, no row touched on apply.
-- Default-empty values mean the resolver returns the same data shape it
-- always has until upstream code starts writing to these columns
-- (deferred to sub-phases A.4+ behind a feature flag).
--
-- Rollback:
--   DROP INDEX "Product_localizedContent_gin_idx";
--   DROP INDEX "ChannelListing_overrideData_gin_idx";
--   ALTER TABLE "Product" DROP COLUMN "localizedContent";
--   ALTER TABLE "ChannelListing" DROP COLUMN "overrideData";

-- 1. Product.localizedContent — per-locale content overrides keyed by ISO
--    code. Default seeds en + it (Xavia primary markets) so the resolver
--    never NPEs on a fresh row. Other locales are added by writes, not
--    schema migrations.
ALTER TABLE "Product"
  ADD COLUMN "localizedContent" JSONB NOT NULL DEFAULT '{"en":{},"it":{}}'::jsonb;

-- 2. ChannelListing.overrideData — JSONB bag for arbitrary master-attribute
--    overrides at the (channel × marketplace) granularity. Distinct from
--    platformAttributes (channel-native fields) and from the explicit
--    titleOverride/priceOverride/etc columns (Phase 20 SSOT). Empty bag
--    on insert; writes happen in Phase B.
ALTER TABLE "ChannelListing"
  ADD COLUMN "overrideData" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. GIN indexes for fast key/containment lookups inside the JSONB blobs.
--    jsonb_path_ops gives smaller indexes + faster @> containment queries
--    than the default jsonb_ops; we don't need key existence (?) operator
--    support so path_ops is the right choice.
CREATE INDEX "Product_localizedContent_gin_idx"
  ON "Product" USING GIN ("localizedContent" jsonb_path_ops);

CREATE INDEX "ChannelListing_overrideData_gin_idx"
  ON "ChannelListing" USING GIN ("overrideData" jsonb_path_ops);
