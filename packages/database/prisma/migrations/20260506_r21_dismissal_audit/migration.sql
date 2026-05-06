-- R.21 — Dismiss audit columns on ReplenishmentRecommendation.
-- Operator-driven status ACTIVE → DISMISSED captures who/when/why
-- so we can answer "why didn't we reorder this?" downstream.
-- Distinct from ACTED (rec was converted to PO/WO) and SUPERSEDED
-- (engine replaced the rec on the next forecast pass).

ALTER TABLE "ReplenishmentRecommendation"
  ADD COLUMN IF NOT EXISTS "dismissedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dismissedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "dismissedReason"   TEXT;
