-- W5.49 rollback. Drops the audit table; existing recovery rows
-- are lost. Idempotent.
DROP TABLE IF EXISTS "ListingRecoveryEvent";
