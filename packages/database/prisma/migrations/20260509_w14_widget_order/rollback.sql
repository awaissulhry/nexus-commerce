-- DO.33 / W14 — rollback for DashboardLayout.widgetOrder.
--
-- Drops the column. Operator order preferences are lost; the
-- frontend falls back to canonical widget order automatically.

ALTER TABLE "DashboardLayout"
  DROP COLUMN IF EXISTS "widgetOrder";
