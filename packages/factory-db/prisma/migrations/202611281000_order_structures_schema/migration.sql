-- CreateEnum
CREATE TYPE "OrderStructureFrom" AS ENUM ('RULE', 'ORDER', 'NORMAL');

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "about" TEXT,
ADD COLUMN     "kindWord" TEXT,
ADD COLUMN     "maxBaskets" INTEGER,
ADD COLUMN     "mergedIntoId" UUID,
ADD COLUMN     "parentTeamId" UUID,
ADD COLUMN     "standInEmployeeId" UUID,
ADD COLUMN     "standInUntil" DATE,
ADD COLUMN     "takesNewOrders" BOOLEAN NOT NULL DEFAULT ('true'::text)::boolean,
ADD COLUMN     "takesOrders" BOOLEAN NOT NULL DEFAULT ('true'::text)::boolean,
ADD COLUMN     "worksForPartyIds" UUID[] DEFAULT ('{}'::text)::uuid[];

-- CreateTable
CREATE TABLE "ScanCodePlacement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "salesOrderLineId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "page" INTEGER NOT NULL,
    "xMm" DECIMAL(8,2) NOT NULL,
    "yMm" DECIMAL(8,2) NOT NULL,
    "sizeMm" DECIMAL(8,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "placedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedById" UUID,

    CONSTRAINT "ScanCodePlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStructure" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "teamIds" UUID[] DEFAULT ('{}'::text)::uuid[],
    "peopleUserIds" UUID[] DEFAULT ('{}'::text)::uuid[],
    "note" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStructureRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "partyId" UUID,
    "category" "ProductType",
    "structureId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT ('true'::text)::boolean,
    "note" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderStructureRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStructureOverride" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "structureId" UUID,
    "normalWay" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean,
    "why" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,

    CONSTRAINT "OrderStructureOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineStructureKept" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "salesOrderLineId" UUID NOT NULL,
    "structureId" UUID,
    "ruleId" UUID,
    "keptFrom" "OrderStructureFrom" NOT NULL,
    "snapshot" JSONB NOT NULL,
    "keptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keptById" UUID,

    CONSTRAINT "OrderLineStructureKept_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScanCodePlacement_tenantId_salesOrderId_idx" ON "ScanCodePlacement"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "ScanCodePlacement_tenantId_fileId_idx" ON "ScanCodePlacement"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanCodePlacement_tenantId_salesOrderLineId_fileId_page_key" ON "ScanCodePlacement"("tenantId", "salesOrderLineId", "fileId", "page");

-- CreateIndex
CREATE INDEX "OrderStructure_tenantId_companyId_idx" ON "OrderStructure"("tenantId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderStructure_tenantId_companyId_id_key" ON "OrderStructure"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "OrderStructureRule_tenantId_companyId_sortOrder_idx" ON "OrderStructureRule"("tenantId", "companyId", "sortOrder");

-- CreateIndex
CREATE INDEX "OrderStructureRule_tenantId_partyId_idx" ON "OrderStructureRule"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "OrderStructureRule_tenantId_structureId_idx" ON "OrderStructureRule"("tenantId", "structureId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderStructureRule_tenantId_companyId_id_key" ON "OrderStructureRule"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "OrderStructureOverride_tenantId_salesOrderId_idx" ON "OrderStructureOverride"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderStructureOverride_tenantId_structureId_idx" ON "OrderStructureOverride"("tenantId", "structureId");

-- CreateIndex
CREATE INDEX "OrderLineStructureKept_tenantId_salesOrderId_idx" ON "OrderLineStructureKept"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderLineStructureKept_tenantId_structureId_idx" ON "OrderLineStructureKept"("tenantId", "structureId");

-- CreateIndex
CREATE INDEX "OrderLineStructureKept_tenantId_ruleId_idx" ON "OrderLineStructureKept"("tenantId", "ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineStructureKept_tenantId_salesOrderLineId_key" ON "OrderLineStructureKept"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE INDEX "Team_tenantId_parentTeamId_idx" ON "Team"("tenantId", "parentTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_tenantId_companyId_id_key" ON "Team"("tenantId", "companyId", "id");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_companyId_parentTeamId_fkey" FOREIGN KEY ("tenantId", "companyId", "parentTeamId") REFERENCES "Team"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_companyId_mergedIntoId_fkey" FOREIGN KEY ("tenantId", "companyId", "mergedIntoId") REFERENCES "Team"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_companyId_standInEmployeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "standInEmployeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCodePlacement" ADD CONSTRAINT "ScanCodePlacement_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCodePlacement" ADD CONSTRAINT "ScanCodePlacement_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCodePlacement" ADD CONSTRAINT "ScanCodePlacement_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderStructure" ADD CONSTRAINT "OrderStructure_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderStructureRule" ADD CONSTRAINT "OrderStructureRule_tenantId_companyId_structureId_fkey" FOREIGN KEY ("tenantId", "companyId", "structureId") REFERENCES "OrderStructure"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderStructureRule" ADD CONSTRAINT "OrderStructureRule_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderStructureOverride" ADD CONSTRAINT "OrderStructureOverride_tenantId_companyId_partyId_salesOrd_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderStructureOverride" ADD CONSTRAINT "OrderStructureOverride_tenantId_companyId_structureId_fkey" FOREIGN KEY ("tenantId", "companyId", "structureId") REFERENCES "OrderStructure"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineStructureKept" ADD CONSTRAINT "OrderLineStructureKept_tenantId_companyId_partyId_salesOrd_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineStructureKept" ADD CONSTRAINT "OrderLineStructureKept_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineStructureKept" ADD CONSTRAINT "OrderLineStructureKept_tenantId_companyId_structureId_fkey" FOREIGN KEY ("tenantId", "companyId", "structureId") REFERENCES "OrderStructure"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineStructureKept" ADD CONSTRAINT "OrderLineStructureKept_tenantId_companyId_ruleId_fkey" FOREIGN KEY ("tenantId", "companyId", "ruleId") REFERENCES "OrderStructureRule"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

