-- Step 3 cases (Owner 2026-10-07, D2 = B: sealed cases and loose units counted apart, per location; Owner 2026-10-08:
-- several case sizes per SKU).
-- ProductPackage: one SKU's FBA prep/label owner (AMAZON | SELLER, null = not set).
-- ProductCaseSize: one case size of a SKU — units per case (unique per SKU: it names the size), case size in cm and case
-- weight in kg. Nexus is the source: Amazon has no API for case-pack templates.
-- StockCaseCount: the sealed cases of one case size at one StockLevel (the StockBinQuantity pattern). StockLevel.quantity
-- stays the UNIT total; loose = quantity − Σ cases × unitsPerCase. The invariant Σ cases × unitsPerCase ≤ quantity is
-- kept in code (stock/stock-cases.service.ts), not by a CHECK: test and fresh databases are built from schema.prisma,
-- which carries none. A removed case size removes its counts (ON DELETE CASCADE): those cases become loose units.
-- Additive only: three new business-owned tables (and their back-relations on Product and StockLevel, which add no
-- column); nothing existing is modified, and with no rows every current screen, push and job behaves exactly as before.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the 20260923a pattern).

-- CreateTable
CREATE TABLE "ProductPackage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fbaPrepOwner" TEXT,
    "fbaLabelOwner" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCaseSize" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitsPerCase" INTEGER NOT NULL,
    "caseLengthCm" DECIMAL(6,1),
    "caseWidthCm" DECIMAL(6,1),
    "caseHeightCm" DECIMAL(6,1),
    "caseWeightKg" DECIMAL(6,2),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCaseSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCaseCount" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "stockLevelId" TEXT NOT NULL,
    "caseSizeId" TEXT NOT NULL,
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
CREATE INDEX "ProductCaseSize_workspaceId_idx" ON "ProductCaseSize"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCaseSize_productId_unitsPerCase_key" ON "ProductCaseSize"("workspaceId", "productId", "unitsPerCase");

-- CreateIndex
CREATE INDEX "StockCaseCount_workspaceId_idx" ON "StockCaseCount"("workspaceId");

-- CreateIndex
CREATE INDEX "StockCaseCount_caseSizeId_idx" ON "StockCaseCount"("caseSizeId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCaseCount_stockLevelId_caseSizeId_key" ON "StockCaseCount"("workspaceId", "stockLevelId", "caseSizeId");

-- AddForeignKey
ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCaseSize" ADD CONSTRAINT "ProductCaseSize_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCaseCount" ADD CONSTRAINT "StockCaseCount_stockLevelId_fkey" FOREIGN KEY ("stockLevelId") REFERENCES "StockLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCaseCount" ADD CONSTRAINT "StockCaseCount_caseSizeId_fkey" FOREIGN KEY ("caseSizeId") REFERENCES "ProductCaseSize"("id") ON DELETE CASCADE ON UPDATE CASCADE;


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
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductCaseSize" TO nexus_workspace_runtime;
ALTER TABLE "ProductCaseSize" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductCaseSize" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductCaseSize";
CREATE POLICY nexus_workspace_isolation ON "ProductCaseSize" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductCaseSize"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductCaseSize"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductCaseSize";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductCaseSize" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
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
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "StockCaseCount" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"StockLevel","from":"stockLevelId","to":"id"},{"model":"ProductCaseSize","from":"caseSizeId","to":"id"}]');
