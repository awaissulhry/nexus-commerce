-- DO.32 / W14 — rollback for the DashboardLayout migration.
--
-- Drops the table and its unique index. DashboardLayout is opt-in
-- operator preference data with no FK dependencies; dropping it
-- only loses the layout customisation rows. The application falls
-- back to "show every widget" when the table is absent.

DROP INDEX IF EXISTS "DashboardLayout_userId_key";
DROP TABLE IF EXISTS "DashboardLayout";
