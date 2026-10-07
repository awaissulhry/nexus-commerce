-- Step 4 Send to FBA (Owner 2026-10-07): the Matrix sends sealed cases and loose units to Amazon FBA through Amazon's
-- "Send to Amazon" v2024-03-20 flow, run as a background job.
-- FbaInboundPlanV2 (exists): nullable job-state columns only — account, marketplace, From warehouse, ship-from address,
--   ready day, mixed box, packing / options / choice / step-log snapshots (Json, typed in @nexus/shared/fba-send), the
--   lease + resume clock (nextCheckAt), who confirmed and when, cancel time and source ('matrix' | 'claude'). No new FK on
--   this table, so its policy and reference trigger stay as they are.
-- FBAShipment (exists): nullable columns for the plan link, Amazon's v2 shipment id, From warehouse, boxes, transport,
--   tracking and the Shipped click. Its shipmentId stays Amazon's shipmentConfirmationId (FBA15…), so the 15-min status
--   poll reads these rows unchanged. No new FK.
-- FbaInboundPlanLine (new, business-owned): one SKU of a plan — msku, units (cases × unitsPerCase + loose), prep/label
--   owner, the hold at the From warehouse (reservationId) and the units shipped so far.
-- Additive only: no existing column changes, no NOT NULL on an existing table; production has 0 plans, and with no new
-- rows every current screen, push and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma (`prisma migrate diff`, schema → schema); (2) row-level security
-- for the new table, emitted by workspaceModelSql() in scripts/workspace-policies.mjs so it carries the same bytes the
-- disposable test database gets (the 20261007c_case_packs pattern).
-- AlterTable
ALTER TABLE "FBAShipment" ADD COLUMN     "amazonShipmentId" TEXT,
ADD COLUMN     "boxes" JSONB,
ADD COLUMN     "planRowId" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippedBy" TEXT,
ADD COLUMN     "sourceLocationId" TEXT,
ADD COLUMN     "tracking" JSONB,
ADD COLUMN     "transport" JSONB;

-- AlterTable
ALTER TABLE "FbaInboundPlanV2" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "channelConnectionId" TEXT,
ADD COLUMN     "choice" JSONB,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedBy" TEXT,
ADD COLUMN     "marketplaceId" TEXT,
ADD COLUMN     "mixedBox" JSONB,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "options" JSONB,
ADD COLUMN     "packing" JSONB,
ADD COLUMN     "readyToShipOn" TIMESTAMP(3),
ADD COLUMN     "source" TEXT,
ADD COLUMN     "sourceAddress" JSONB,
ADD COLUMN     "sourceLocationId" TEXT,
ADD COLUMN     "steps" JSONB;

-- CreateTable
CREATE TABLE "FbaInboundPlanLine" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "planRowId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "msku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "cases" INTEGER NOT NULL DEFAULT 0,
    "unitsPerCase" INTEGER,
    "looseUnits" INTEGER NOT NULL DEFAULT 0,
    "prepOwner" TEXT NOT NULL,
    "labelOwner" TEXT NOT NULL,
    "reservationId" TEXT,
    "shippedQuantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FbaInboundPlanLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FbaInboundPlanLine_workspaceId_idx" ON "FbaInboundPlanLine"("workspaceId");

-- CreateIndex
CREATE INDEX "FbaInboundPlanLine_productId_idx" ON "FbaInboundPlanLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "FbaInboundPlanLine_planRowId_productId_key" ON "FbaInboundPlanLine"("workspaceId", "planRowId", "productId");

-- CreateIndex
CREATE INDEX "FBAShipment_planRowId_idx" ON "FBAShipment"("planRowId");

-- CreateIndex
CREATE INDEX "FbaInboundPlanV2_status_nextCheckAt_idx" ON "FbaInboundPlanV2"("status", "nextCheckAt");

-- AddForeignKey
ALTER TABLE "FbaInboundPlanLine" ADD CONSTRAINT "FbaInboundPlanLine_planRowId_fkey" FOREIGN KEY ("planRowId") REFERENCES "FbaInboundPlanV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaInboundPlanLine" ADD CONSTRAINT "FbaInboundPlanLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FbaInboundPlanLine" TO nexus_workspace_runtime;
ALTER TABLE "FbaInboundPlanLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FbaInboundPlanLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FbaInboundPlanLine";
CREATE POLICY nexus_workspace_isolation ON "FbaInboundPlanLine" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInboundPlanLine"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FbaInboundPlanLine"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FbaInboundPlanLine";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FbaInboundPlanLine" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"FbaInboundPlanV2","from":"planRowId","to":"id"},{"model":"Product","from":"productId","to":"id"}]');
