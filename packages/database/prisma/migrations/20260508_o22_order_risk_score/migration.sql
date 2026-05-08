-- O.22 — Order risk-score audit table.
--
-- The Customer.riskFlag (LOW|MEDIUM|HIGH) column from O.20 is the
-- rolled-up "should this customer be in the manual-review queue"
-- signal. This new OrderRiskScore table is the audit trail behind
-- it: which signals fired on which order, the per-order numeric
-- score (0–100), and a human-readable reason list.
--
-- Operators see the rollup on the /customers list (riskFlag column);
-- when they want to know WHY a customer is flagged, the /customers
-- /:id detail joins through OrderRiskScore to show the breakdown
-- per order: "First order >€500 from new customer" / "5 orders in
-- last 24h" / etc.
--
-- One row per Order — recompute = upsert. Recomputation happens at
-- ingest (per the order-risk.service writer) + on demand via the
-- existing /api/customers/:id/refresh-cache (rolled into the
-- customer-cache service in O.21a).

CREATE TABLE IF NOT EXISTS "OrderRiskScore" (
  "id"      TEXT NOT NULL,
  "orderId" TEXT NOT NULL,

  -- 0–100 cumulative; flag is the bucketed presentation tier:
  --   0–19  → LOW   (or no badge)
  --   20–39 → MEDIUM
  --   40+   → HIGH (auto-promotes Customer.manualReviewState='PENDING')
  "score" INTEGER NOT NULL,
  "flag"  TEXT    NOT NULL,

  -- { addressMismatch?: boolean, velocity24h?: number,
  --   highValueFirstOrder?: boolean, internationalHighValue?: boolean,
  --   anomalousLtvJump?: boolean, priorCancellations?: number }
  -- JSONB so future signals append without schema churn.
  "signals" JSONB NOT NULL,

  -- Operator-visible explanation: ["First order >€500 from new customer",
  -- "Order €450 is 3× customer's avg of €150", ...]
  "reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderRiskScore_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderRiskScore_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE
);

-- One score per order. Re-runs upsert on this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "OrderRiskScore_orderId_key"
  ON "OrderRiskScore"("orderId");
CREATE INDEX IF NOT EXISTS "OrderRiskScore_flag_idx"
  ON "OrderRiskScore"("flag");
CREATE INDEX IF NOT EXISTS "OrderRiskScore_score_idx"
  ON "OrderRiskScore"("score");
CREATE INDEX IF NOT EXISTS "OrderRiskScore_computedAt_idx"
  ON "OrderRiskScore"("computedAt");

-- Customer cache: track the last time the rollup was recomputed so
-- the /customers list can display a "Last scored: 2h ago" affordance
-- and the operator can detect stale rollups.
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "lastRiskComputedAt" TIMESTAMP(3);
