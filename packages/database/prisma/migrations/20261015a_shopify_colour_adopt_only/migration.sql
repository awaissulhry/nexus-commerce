-- Shopify colour products, adopt only (2026-10-15). Additive only: one column with a default, no data moved.
--
--   ShopifyColourSync.adoptOnly   true: Confirm linked this family's colours to live Shopify products (the Nexus
--                                 identity and missing SKUs only), and Nexus writes nothing else to them — no stock,
--                                 no sizes, no size order, no archive, no colour swatch fields — until an operator
--                                 starts the full sync. false: the full sync runs.
--
-- Every row stored before this release reads false, so a family already syncing keeps syncing exactly as before.

-- AlterTable
ALTER TABLE "ShopifyColourSync" ADD COLUMN "adoptOnly" BOOLEAN NOT NULL DEFAULT false;
