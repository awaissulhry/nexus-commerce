-- =====================================================================
-- H.14: Channel refund traceability on Return
--
-- Existing /fulfillment/returns/:id/refund only flipped the local
-- Return.refundStatus to REFUNDED — no Amazon/eBay/Shopify push, so
-- the operator ended up issuing the same refund twice (once in
-- Nexus, once manually in Seller Central / eBay back office).
--
-- This migration adds three columns the new refund-publisher
-- service writes to:
--   channelRefundId    — id returned by eBay (refundId) / Shopify
--                        (refundGid) / WooCommerce (refundId). Null
--                        when the channel adapter is stub-only.
--   channelRefundError — last error message from the channel push;
--                        non-null when refundStatus = CHANNEL_FAILED.
--   channelRefundedAt  — when the channel acknowledged the refund
--                        (distinct from refundedAt which is when the
--                        operator marked the local row).
--
-- All three columns nullable. Existing rows backfill to NULL — they
-- pre-date the channel-publish path and were marked refunded
-- locally only.
-- =====================================================================

ALTER TABLE "Return"
  ADD COLUMN "channelRefundId"    TEXT,
  ADD COLUMN "channelRefundError" TEXT,
  ADD COLUMN "channelRefundedAt"  TIMESTAMP(3);
