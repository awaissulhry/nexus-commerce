-- RV.2.1 — track the provenance of Order.deliveredAt.
--
-- The review-request pipeline schedules off deliveredAt. Today the only
-- writer is the Amazon SP-API mapping (status='Delivered' → deliveredAt
-- = LastUpdateDate), but SP-API rarely returns Delivered for FBA orders.
-- 2-year-old shipped orders never matured past SHIPPED. RV.2.2 adds a
-- 3-business-day-after-shippedAt heuristic for FBA orders so the review
-- pipeline has something to act on; the source column lets us distinguish
-- the heuristic guess from authoritative signals (carrier webhooks, MCF,
-- SP-API itself) and never let the heuristic clobber a real value.
--
-- Enum is encoded as TEXT to match the existing "channel" / "status"
-- pattern in this schema — keeps migrations simple, allows new values
-- without ALTER TYPE. Application-level code validates the value set.

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "deliveredAtSource" TEXT;
