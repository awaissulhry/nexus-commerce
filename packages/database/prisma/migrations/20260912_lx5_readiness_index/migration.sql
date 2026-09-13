-- LX.5: new table only. No business data changes and no trigger/function.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE "ReadinessIndex" (
 "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
 "id" TEXT NOT NULL,
 "productId" TEXT NOT NULL,
 "coordinateKey" TEXT NOT NULL,
 "channel" TEXT,
 "market" TEXT,
 "accountId" TEXT,
 "aliasId" TEXT,
 "language" TEXT NOT NULL,
 "label" TEXT NOT NULL,
 "pct" INTEGER,
 "state" TEXT NOT NULL,
 "requiredFilled" INTEGER NOT NULL,
 "requiredTotal" INTEGER NOT NULL,
 "missing" JSONB NOT NULL,
 "note" TEXT,
 "mappingRules" INTEGER,
 "computedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ReadinessIndex_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "ReadinessIndex_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReadinessIndex_workspaceId_productId_coordinateKey_language_key" ON "ReadinessIndex"("workspaceId", "productId", "coordinateKey", "language");
CREATE INDEX "ReadinessIndex_channel_market_language_state_idx" ON "ReadinessIndex"("channel", "market", "language", "state");
CREATE INDEX "ReadinessIndex_productId_idx" ON "ReadinessIndex"("productId");
CREATE INDEX "ReadinessIndex_workspaceId_idx" ON "ReadinessIndex"("workspaceId");
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "ReadinessIndex" TO nexus_workspace_runtime;
 END IF;
END $$;
COMMIT;
