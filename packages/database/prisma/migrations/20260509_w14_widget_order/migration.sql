-- DO.33 / W14 — DashboardLayout.widgetOrder.
--
-- Adds the operator-defined widget ordering column to the
-- DashboardLayout row introduced by 20260509_w14_dashboard_layout.
-- Empty default means "use the canonical client-side order" so
-- existing rows degrade unchanged.
--
-- Idempotent ADD COLUMN IF NOT EXISTS so re-runs are no-ops.

ALTER TABLE "DashboardLayout"
  ADD COLUMN IF NOT EXISTS "widgetOrder" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
