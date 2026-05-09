-- Rollback for L.15.0 — drop SyncLogSavedSearch and its index.
DROP INDEX IF EXISTS "SyncLogSavedSearch_surface_name_idx";
DROP TABLE IF EXISTS "SyncLogSavedSearch";
