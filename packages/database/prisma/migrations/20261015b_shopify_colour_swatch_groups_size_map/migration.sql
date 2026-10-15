-- Shopify colour products: the store's swatch groups and the size map (2026-10-15). Additive only: two nullable JSON
-- columns, no data moved.
--
--   ShopifyColourProduct.swatchGroup   the product GIDs of the colour list (custom.variation_products) the product has
--                                      on the store, as Find or Confirm read it. The link writer writes one list per
--                                      stored group instead of one list with every colour of the family.
--   ShopifyColourSync.sizeMap          per native option axis, a Nexus value -> the Shopify option value it is on this
--                                      store (EU 44 -> XS). Find, Confirm and the colour sync pair and create sizes by it.
--
-- Every row stored before this release reads null: no group known (the family's colours stay one group, as before) and
-- no size map (every value is itself, as before).

-- AlterTable
ALTER TABLE "ShopifyColourProduct" ADD COLUMN "swatchGroup" JSONB;

-- AlterTable
ALTER TABLE "ShopifyColourSync" ADD COLUMN "sizeMap" JSONB;
