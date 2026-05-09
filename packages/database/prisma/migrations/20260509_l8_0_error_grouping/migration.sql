-- L.8.0 — Sentry-tier error grouping for sync logs.
--
-- Each unique (channel × operation × errorType × errorCode ×
-- normalised-message) hashes to one fingerprint and upserts one
-- SyncLogErrorGroup row that the per-failure write in recordApiCall
-- increments. Operators see "Amazon SP-API throttle exceeded × 142"
-- not 142 individual rows.

CREATE TABLE IF NOT EXISTS "SyncLogErrorGroup" (
  "id"               TEXT NOT NULL,
  "fingerprint"      TEXT NOT NULL,
  "channel"          TEXT NOT NULL,
  "operation"        TEXT NOT NULL,
  "errorType"        TEXT,
  "errorCode"        TEXT,
  "sampleMessage"    TEXT,
  "count"            INTEGER NOT NULL DEFAULT 1,
  "firstSeen"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolutionStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  "resolvedAt"       TIMESTAMP(3),
  "resolvedBy"       TEXT,
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncLogErrorGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SyncLogErrorGroup_fingerprint_key"
  ON "SyncLogErrorGroup"("fingerprint");

CREATE INDEX IF NOT EXISTS "SyncLogErrorGroup_channel_lastSeen_idx"
  ON "SyncLogErrorGroup"("channel", "lastSeen");
CREATE INDEX IF NOT EXISTS "SyncLogErrorGroup_resolutionStatus_lastSeen_idx"
  ON "SyncLogErrorGroup"("resolutionStatus", "lastSeen");
CREATE INDEX IF NOT EXISTS "SyncLogErrorGroup_lastSeen_idx"
  ON "SyncLogErrorGroup"("lastSeen");
