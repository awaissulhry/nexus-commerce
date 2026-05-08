-- P2 #4 cleanup — purge `CategorySchema` rows with schemaVersion='unknown'.
--
-- These are orphans from the first D.3f deployment that read the wrong
-- path (`meta.version`) on the SP-API envelope. After the path fix they
-- never get returned (the real-version row always wins on
-- `fetchedAt desc`) but they take up unique-constraint slots until 24h
-- expiry. This migration purges the residual once-per-deploy so the
-- table stays clean without waiting on TTL.
--
-- Idempotent: re-runs are safe because the WHERE clause matches only
-- the orphan class; legitimate rows always carry the parsed version.

DELETE FROM "CategorySchema" WHERE "schemaVersion" = 'unknown';
