-- FCF.1 — per channel×marketplace fulfillment method.
--
-- Promotes fulfillment off the product-level Product.fulfillmentMethod onto
-- the ChannelListing (which is already keyed per channel + marketplace via
-- @@unique([productId, channel, marketplace])). This lets the same product
-- be FBA on Amazon-IT but FBM on Amazon-DE, and FBM on eBay — and (in later
-- FCF phases) bind each listing's published quantity to the correct stock
-- pool (FBA inventory vs own-warehouse / FBM).
--
-- Pure additive: one nullable enum column + a seed backfill. No NOT NULL,
-- no existing column altered, so it applies online under migrate deploy.
-- Backfill is a best-effort SEED only — null stays null and callers derive
-- (eBay→FBM, Amazon→Product.fulfillmentMethod / stock location). Nothing
-- reads this column for publishing yet (that lands in FCF.3), so this is a
-- no-behaviour-change migration.
--
-- Rollback:
--   ALTER TABLE "ChannelListing" DROP COLUMN "fulfillmentMethod";

ALTER TABLE "ChannelListing" ADD COLUMN "fulfillmentMethod" "FulfillmentMethod";

-- Merchant-fulfilled channels are always FBM (the seller ships from their
-- own warehouse) — eBay, Shopify, WooCommerce, Etsy.
UPDATE "ChannelListing"
   SET "fulfillmentMethod" = 'FBM'::"FulfillmentMethod"
 WHERE "channel" IN ('EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY')
   AND "fulfillmentMethod" IS NULL;

-- Amazon listings seed from the product's current method when known; rows
-- where the product method is null stay null and are derived at read time.
UPDATE "ChannelListing" cl
   SET "fulfillmentMethod" = p."fulfillmentMethod"
  FROM "Product" p
 WHERE cl."productId" = p."id"
   AND cl."channel" = 'AMAZON'
   AND cl."fulfillmentMethod" IS NULL
   AND p."fulfillmentMethod" IS NOT NULL;
