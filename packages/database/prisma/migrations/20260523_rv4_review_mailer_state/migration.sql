-- RV.4.1 — Operational kill switch for the review-request mailer.
--
-- Singleton row pattern: the application layer always reads/writes the
-- row with id='default'. When isPaused=true, the cron tick logs a paused
-- run and skips all sends (no API calls, no DB writes to ReviewRequest).
--
-- This is distinct from NEXUS_ENABLE_REVIEW_INGEST (env-flag startup
-- gate). The env flag controls whether the cron is scheduled at all;
-- this row controls whether scheduled ticks actually send.

CREATE TABLE IF NOT EXISTS "ReviewMailerState" (
  "id"           TEXT NOT NULL DEFAULT 'default',
  "isPaused"     BOOLEAN NOT NULL DEFAULT false,
  "pausedReason" TEXT,
  "pausedAt"     TIMESTAMP(3),
  "pausedBy"     TEXT,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewMailerState_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row so the application doesn't have to handle
-- "row missing" specially.
INSERT INTO "ReviewMailerState" ("id", "isPaused", "updatedAt")
VALUES ('default', false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
