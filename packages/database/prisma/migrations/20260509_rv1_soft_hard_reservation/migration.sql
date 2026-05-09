-- RV.1 — Soft vs Hard reservation distinction.
--
-- HARD = reserved + decrements StockLevel.reserved (current default).
--        Used for confirmed orders, FBA inbound, MCF.
-- SOFT = visible advisory hold; does NOT decrement available. Used for
--        cart hold, payment-pending, pre-order. Surfaces in ATP-soft
--        but not ATP-hard.
--
-- Default 'HARD' for backwards-compat with every existing reservation.

ALTER TABLE "StockReservation"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'HARD';

ALTER TABLE "StockReservation"
  DROP CONSTRAINT IF EXISTS "StockReservation_kind_valid";

ALTER TABLE "StockReservation"
  ADD CONSTRAINT "StockReservation_kind_valid"
  CHECK ("kind" IN ('SOFT', 'HARD'));

CREATE INDEX IF NOT EXISTS "StockReservation_kind_idx"
  ON "StockReservation"("kind");
