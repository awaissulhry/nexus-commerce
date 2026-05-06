-- =====================================================================
-- R.13 — Event-driven prep mode
--
-- Surfaces RetailEvent prep deadlines as actionable urgency on
-- relevant SKUs. RetailEvent table itself already exists (used by
-- the forecast signal layer); R.13 only adds audit fields.
-- =====================================================================

-- Per-supplier opt-in for event-prep auto-PO (separate from R.6's
-- general autoTriggerEnabled — event prep creates large up-front
-- orders that should be opted in explicitly).
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "autoTriggerEventPrep" BOOLEAN NOT NULL DEFAULT false;

-- Recommendation audit fields
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "prepEventId"    TEXT;
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "prepExtraUnits" INTEGER;
