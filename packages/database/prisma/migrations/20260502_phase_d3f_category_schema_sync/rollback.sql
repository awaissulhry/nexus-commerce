-- Rollback for D.3f: drop the new schema-sync tables.
--
-- DESTRUCTIVE — wipes all cached schemas + change log. Run only if
-- this migration needs to be reverted.

DROP TABLE IF EXISTS "SchemaChange";
DROP TABLE IF EXISTS "CategorySchema";
