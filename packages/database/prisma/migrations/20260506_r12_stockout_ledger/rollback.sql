-- Rollback for R.12 stockout ledger
DROP INDEX IF EXISTS "StockoutEvent_one_open_per_scope";
DROP TABLE IF EXISTS "StockoutEvent";
