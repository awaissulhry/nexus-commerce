-- T.6 — Multi-currency capture on StockCostLayer.
--
-- Italian fiscal compliance (Codice Civile Art. 2427-bis) requires
-- inventory valuation in EUR at the historical exchange rate on the
-- receive date. Xavia imports goods in USD/GBP from non-EU
-- suppliers; today we store cents only with no currency hint, so
-- the accountant has to pull the ECB rate from another tool and
-- reconcile by hand at year-end.
--
-- After this migration:
--  - costCurrency  ISO-4217 code of the supplier invoice currency
--                  (default EUR for backward compatibility)
--  - exchangeRateOnReceive
--                  rate to base (EUR). NULL when costCurrency = 'EUR'
--                  or when the rate was not yet known. Stored at
--                  Decimal(14,8) — same precision the ECB publishes.

ALTER TABLE "StockCostLayer"
  ADD COLUMN "costCurrency" TEXT NOT NULL DEFAULT 'EUR';

ALTER TABLE "StockCostLayer"
  ADD COLUMN "exchangeRateOnReceive" DECIMAL(14, 8);

-- Sanity: when currency is foreign, an exchange rate must be present.
-- Backward-compatible: existing rows are EUR/NULL and pass.
ALTER TABLE "StockCostLayer"
  ADD CONSTRAINT "StockCostLayer_currency_rate_consistency"
  CHECK ("costCurrency" = 'EUR' OR "exchangeRateOnReceive" IS NOT NULL);
