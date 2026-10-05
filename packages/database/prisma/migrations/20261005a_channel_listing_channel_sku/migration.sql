-- Per-listing channel SKU (2026-10-05; plan docs/sheet-ids-sku-rows/PLAN.md, step S1).
--
-- The Owner's rule: a SKU edit in a channel scope of the product sheet belongs to that listing only (that channel, that
-- market); a SKU edit in the Shared scope changes Product.sku. Two columns on the listing row hold it:
--   - channelSku: the SKU Nexus sends to this channel and market. NULL = the product's own SKU (Product.sku), which is
--     what every row means today.
--   - liveChannelSku: the SKU the channel holds for this listing now, written only when the channel confirms it (an
--     accepted publish, a pull, an import). NULL = the channel holds nothing Nexus knows of.
-- Every reader goes through apps/api/src/services/listings/channel-sku.ts.
--
-- Additive only: two nullable columns on an existing business-owned table (ChannelListing is already classified in
-- workspaces/model-ownership.json; its row-level security covers every column) and one index per column. A channel SKU
-- is held by very few rows, so a single-column index serves both lookups: matching a channel's SKU back on one connected
-- account (orders, returns, stock reports) and the write guard's lookup across every account (PostgreSQL 17 cannot skip
-- the first column of a composite index). Every existing row stays NULL, so nothing is read differently until a writer
-- sets a value. Idempotent: it can run twice.

-- AlterTable
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "channelSku" TEXT,
ADD COLUMN IF NOT EXISTS "liveChannelSku" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChannelListing_channelSku_idx" ON "ChannelListing"("channelSku");
CREATE INDEX IF NOT EXISTS "ChannelListing_liveChannelSku_idx" ON "ChannelListing"("liveChannelSku");
