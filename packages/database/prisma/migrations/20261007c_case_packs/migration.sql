-- Step 3 cases (Owner 2026-10-07, D2 = B: sealed cases and loose units counted apart, per location).
-- ProductPackage: one SKU's case pack (units per case, case size in cm, case weight in kg) and its FBA prep/label owner
-- (AMAZON | SELLER, null = not set). Nexus is the source: Amazon has no API for case-pack templates.
-- StockCaseCount: the sealed cases at one StockLevel (the StockBinQuantity pattern). StockLevel.quantity stays the UNIT
-- total; loose = quantity − cases × unitsPerCase. The invariant cases × unitsPerCase ≤ quantity is kept in code
-- (stock/stock-cases.service.ts), not by a CHECK: test and fresh databases are built from schema.prisma, which carries none.
-- Additive only: two new business-owned tables (and their back-relations on Product and StockLevel, which add no
-- column); nothing existing is modified, and with no rows every current screen, push and job behaves exactly as before.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the 20260923a pattern).

-- CreateTable
CREATE TABLE "ProductPackage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitsPerCase" INTEGER,
    "caseLengthCm" DECIMAL(6,1),
    "caseWidthCm" DECIMAL(6,1),
    "caseHeightCm" DECIMAL(6,1),
    "caseWeightKg" DECIMAL(6,2),
    "fbaPrepOwner" TEXT,
    "fbaLabelOwner" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCaseCount" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "stockLevelId" TEXT NOT NULL,
    "cases" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCaseCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPackage_workspaceId_idx" ON "ProductPackage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPackage_productId_key" ON "ProductPackage"("workspaceId", "productId");

-- CreateIndex
CREATE INDEX "StockCaseCount_workspaceId_idx" ON "StockCaseCount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCaseCount_stockLevelId_key" ON "StockCaseCount"("workspaceId", "stockLevelId");

-- AddForeignKey
ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCaseCount" ADD CONSTRAINT "StockCaseCount_stockLevelId_fkey" FOREIGN KEY ("stockLevelId") REFERENCES "StockLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for the business-owned tables ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductPackage" TO nexus_workspace_runtime;
ALTER TABLE "ProductPackage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductPackage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductPackage";
CREATE POLICY nexus_workspace_isolation ON "ProductPackage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductPackage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductPackage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductPackage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductPackage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockCaseCount" TO nexus_workspace_runtime;
ALTER TABLE "StockCaseCount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockCaseCount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockCaseCount";
CREATE POLICY nexus_workspace_isolation ON "StockCaseCount" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockCaseCount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockCaseCount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "StockCaseCount";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockCaseCount" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"StockLevel","from":"stockLevelId","to":"id"}]');
