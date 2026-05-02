-- Follow-up to 20260503_p0_31_channel_connection: add the
-- VariantChannelListing.channel TEXT column.
--
-- Caught during Phase 1 verification — the listings handler hit
-- "column VariantChannelListing.channel does not exist" because
-- Prisma's default findMany selects every schema-declared column,
-- and `channel String?` is in schema.prisma but the prior migration
-- only added the seven columns the eBay code writes to. The `channel`
-- column is read-only from eBay's side (just stored at row creation
-- to discriminate AMAZON / EBAY / SHOPIFY / WOOCOMMERCE rows).

ALTER TABLE "VariantChannelListing"
  ADD COLUMN IF NOT EXISTS "channel" TEXT;
