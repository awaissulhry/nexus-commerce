-- P4.6e — Etsy becomes a destination the outbound queue can name.
--
-- `SyncChannel` held AMAZON, EBAY, SHOPIFY, WOOCOMMERCE, GOOGLE, META, TIKTOK — and no ETSY,
-- although Etsy has been a connected channel since P2.5. So no OutboundSyncQueue row could name
-- an Etsy destination, and P4.6's writers had no way to be reached from the queue.
--
-- Additive and reversible by disuse: adding an enum value changes no existing row and no existing
-- read. Nothing selects on it until the lane in outbound-sync.service.ts is deployed with it.
ALTER TYPE "SyncChannel" ADD VALUE IF NOT EXISTS 'ETSY';
