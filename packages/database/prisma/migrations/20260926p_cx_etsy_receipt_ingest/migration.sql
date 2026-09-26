-- CX Etsy (2026-09-24) — Etsy receipt ingest. Additive only: two new tables; nothing existing is
-- altered.
--
-- (2) "EtsyReceiptIngest" (E3/E5/E6) — per connected Etsy account: T0 (activatedAt, set once by the
--     database clock when ingest first runs), the poller's keyset cursor, its lease, its outcome.
-- (3) "EtsyReceiptRefusal" (E4/E5) — every receipt Nexus refused to ingest, durably.
-- (1), the per-line "OrderLineHold" table, was dropped before any deployment (stock model
-- 2026-09-26, R9): an order's hold is one per (order, product) in the stock ledger itself.
-- Rollback: DROP TABLE "EtsyReceiptRefusal", "EtsyReceiptIngest"; (nothing else depends on them).
-- The two Etsy tables cascade with their connection, like its other dependents.

-- The two foreign keys lock "ChannelConnection", which every request reads: fail fast (the release
-- is retried) rather than queue behind a long transaction and hold up traffic behind the lock.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- (2) and (3) — Etsy receipt ingest state and refusals.
-- CreateTable
CREATE TABLE "EtsyReceiptIngest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cursorUpdatedAt" TIMESTAMP(3),
    "cursorReceiptId" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastPollStartedAt" TIMESTAMP(3),
    "lastPollSucceededAt" TIMESTAMP(3),
    "lastPollStatus" TEXT,
    "lastPollError" TEXT,
    "backlog" BOOLEAN NOT NULL DEFAULT false,
    "lastPollCounts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EtsyReceiptIngest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtsyReceiptRefusal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "receiptVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EtsyReceiptRefusal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EtsyReceiptIngest_workspaceId_idx" ON "EtsyReceiptIngest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EtsyReceiptIngest_connectionId_key" ON "EtsyReceiptIngest"("workspaceId", "connectionId");

-- CreateIndex
CREATE INDEX "EtsyReceiptRefusal_connectionId_createdAt_idx" ON "EtsyReceiptRefusal"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "EtsyReceiptRefusal_workspaceId_idx" ON "EtsyReceiptRefusal"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EtsyReceiptRefusal_version_code_key" ON "EtsyReceiptRefusal"("workspaceId", "connectionId", "receiptId", "receiptVersion", "code");

-- AddForeignKey
ALTER TABLE "EtsyReceiptIngest" ADD CONSTRAINT "EtsyReceiptIngest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtsyReceiptRefusal" ADD CONSTRAINT "EtsyReceiptRefusal_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security for (2) and (3): exactly the bytes packages/database/scripts/workspace-policies.mjs emits.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EtsyReceiptIngest" TO nexus_workspace_runtime;
ALTER TABLE "EtsyReceiptIngest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EtsyReceiptIngest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EtsyReceiptIngest";
CREATE POLICY nexus_workspace_isolation ON "EtsyReceiptIngest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EtsyReceiptIngest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EtsyReceiptIngest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EtsyReceiptIngest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EtsyReceiptIngest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EtsyReceiptRefusal" TO nexus_workspace_runtime;
ALTER TABLE "EtsyReceiptRefusal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EtsyReceiptRefusal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EtsyReceiptRefusal";
CREATE POLICY nexus_workspace_isolation ON "EtsyReceiptRefusal" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EtsyReceiptRefusal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EtsyReceiptRefusal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EtsyReceiptRefusal";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EtsyReceiptRefusal" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');

COMMIT;
