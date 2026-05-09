-- DO.30 / W12 — rollback for the Goal model migration.
--
-- Drops the table and its indexes. Goal is opt-in operator data
-- with no FK dependencies, so dropping it is non-destructive to
-- the rest of the schema. The application gracefully degrades
-- when the table is absent (the dashboard read query wears
-- .catch(() => []) to handle missing-table conditions).

DROP INDEX IF EXISTS "Goal_period_idx";
DROP INDEX IF EXISTS "Goal_userId_status_idx";
DROP TABLE IF EXISTS "Goal";
