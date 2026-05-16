-- AD.4 — AdvertisingActionLog: unified write log for Trading Desk
-- actions (operator + automation), with payloadBefore/payloadAfter
-- snapshots for the rollback flow.

CREATE TABLE IF NOT EXISTS "AdvertisingActionLog" (
  "id" TEXT PRIMARY KEY,
  "executionId" TEXT,
  "userId" TEXT,
  "actionType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "payloadBefore" JSONB NOT NULL,
  "payloadAfter" JSONB NOT NULL,
  "outboundQueueId" TEXT,
  "amazonResponseId" TEXT,
  "amazonResponseStatus" TEXT,
  "rolledBackAt" TIMESTAMP(3),
  "rollbackReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AdvertisingActionLog_executionId_createdAt_idx"
  ON "AdvertisingActionLog" ("executionId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AdvertisingActionLog_entityType_entityId_createdAt_idx"
  ON "AdvertisingActionLog" ("entityType", "entityId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AdvertisingActionLog_createdAt_idx"
  ON "AdvertisingActionLog" ("createdAt" DESC);
