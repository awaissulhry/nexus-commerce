-- T.8 part 2 — Year-end inventory snapshot ("rimanenze finali").
--
-- Materialised by the Jan-1 cron from the prior year's cost-layer
-- state, or manually via POST /api/stock/year-end-valuation/snapshot.
-- One row per (year); reads are point-in-time stable.
--
-- This closes the asof=current-state limitation T.8 (commit 611ab6c)
-- disclosed: when the operator runs the rimanenze report on Jan 5
-- expecting Dec 31 fixity, the endpoint now returns the snapshot
-- if one exists, falling back to live state with a clear flag.

CREATE TABLE "YearEndSnapshot" (
  "id"                  TEXT PRIMARY KEY,
  "year"                INTEGER NOT NULL,
  "asOf"                TIMESTAMP NOT NULL,
  "snapshotAt"          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "totalUnits"          INTEGER NOT NULL,
  "totalValueEurCents"  INTEGER NOT NULL,
  "layerCount"          INTEGER NOT NULL,
  "byLocation"          JSONB   NOT NULL,
  "byMethod"            JSONB   NOT NULL,
  "byCurrency"          JSONB   NOT NULL,
  "vatTreatment"        JSONB   NOT NULL,
  "notes"               TEXT
);

CREATE UNIQUE INDEX "YearEndSnapshot_year_key" ON "YearEndSnapshot"("year");
CREATE INDEX "YearEndSnapshot_year_idx" ON "YearEndSnapshot"("year");
