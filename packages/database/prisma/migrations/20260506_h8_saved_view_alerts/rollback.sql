-- Rollback for 20260506_h8_saved_view_alerts. Drops in dependency
-- order; SavedViewAlert FKs SavedView so dropping it first.
DROP TABLE IF EXISTS "SavedViewAlert";
DROP TABLE IF EXISTS "Notification";
