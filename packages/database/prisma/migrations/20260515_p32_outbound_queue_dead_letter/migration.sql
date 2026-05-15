-- P3.2 — Dead-letter queue fields on OutboundSyncQueue
-- isDead=true when retryCount >= maxRetries and status=FAILED.
-- Surfaced in the /sync-logs/outbound-queue Dead Letters tab.

ALTER TABLE "OutboundSyncQueue" ADD COLUMN IF NOT EXISTS "isDead" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OutboundSyncQueue" ADD COLUMN IF NOT EXISTS "diedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "OutboundSyncQueue_isDead_targetChannel_idx" ON "OutboundSyncQueue"("isDead", "targetChannel");
