-- Rollback for L.8.0 — drop SyncLogErrorGroup and its indexes.
DROP INDEX IF EXISTS "SyncLogErrorGroup_lastSeen_idx";
DROP INDEX IF EXISTS "SyncLogErrorGroup_resolutionStatus_lastSeen_idx";
DROP INDEX IF EXISTS "SyncLogErrorGroup_channel_lastSeen_idx";
DROP INDEX IF EXISTS "SyncLogErrorGroup_fingerprint_key";
DROP TABLE IF EXISTS "SyncLogErrorGroup";
