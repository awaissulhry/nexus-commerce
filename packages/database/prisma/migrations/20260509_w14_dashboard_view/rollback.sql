-- DO.39 / W14 — rollback for DashboardView.
--
-- Drops the named-views table + indexes and clears the activeViewId
-- pointer column. Live DashboardLayout settings remain intact.

ALTER TABLE "DashboardLayout" DROP COLUMN IF EXISTS "activeViewId";
DROP INDEX IF EXISTS "DashboardView_userId_idx";
DROP INDEX IF EXISTS "DashboardView_userId_name_key";
DROP TABLE IF EXISTS "DashboardView";
