-- CE.3: Buy Box Engine Completion
-- Add marginAtObservation to BuyBoxHistory for MAXIMIZE_MARGIN_WIN_BOX strategy.
-- Stores (buyBoxPrice - costPrice) / buyBoxPrice at snapshot time so the
-- win-rate-trend analysis can weight observations by margin quality.

ALTER TABLE "BuyBoxHistory"
  ADD COLUMN IF NOT EXISTS "marginAtObservation" DECIMAL(8, 4);
