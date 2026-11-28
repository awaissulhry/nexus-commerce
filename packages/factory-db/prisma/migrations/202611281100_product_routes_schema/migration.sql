-- CreateEnum
CREATE TYPE "StyleRouteKind" AS ENUM ('MODEL', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "RouteTemplateStatus" AS ENUM ('OPEN', 'CLOSED');

-- DropIndex
DROP INDEX "LabourRate_tenantId_companyId_workCentreKind_validFrom_key";

-- AlterTable
ALTER TABLE "BomLine" ADD COLUMN     "isMain" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean;

-- AlterTable
ALTER TABLE "CostSheet" ADD COLUMN     "keptAloneReason" TEXT;

-- AlterTable
ALTER TABLE "CostingSettings" ADD COLUMN     "oneKeeperAllowed" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean;

-- AlterTable
ALTER TABLE "LabourRate" ADD COLUMN     "departmentId" UUID;

-- CreateTable
CREATE TABLE "StyleRoute" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StyleRouteKind" NOT NULL,
    "partyId" UUID,
    "seq" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleRouteStep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "revisionId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "departmentId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "minutes" DECIMAL(10,3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleRouteStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "name" TEXT NOT NULL,
    "status" "RouteTemplateStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RouteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteTemplateStep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "templateId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "departmentId" UUID NOT NULL,
    "minutes" DECIMAL(10,3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RouteTemplateStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLineRoute" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "salesOrderLineId" UUID NOT NULL,
    "styleRouteId" UUID,
    "pickedAt" TIMESTAMPTZ(3),
    "pickedById" UUID,
    "exceptionSteps" JSONB,
    "exceptionReason" TEXT,
    "exceptionAt" TIMESTAMPTZ(3),
    "exceptionById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrderLineRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StyleRoute_tenantId_styleId_idx" ON "StyleRoute"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "StyleRoute_tenantId_partyId_idx" ON "StyleRoute"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "StyleRoute_tenantId_revisionId_name_key" ON "StyleRoute"("tenantId", "revisionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "StyleRoute_tenantId_revisionId_id_key" ON "StyleRoute"("tenantId", "revisionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StyleRoute_tenantId_id_key" ON "StyleRoute"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StyleRouteStep_tenantId_routeId_seq_key" ON "StyleRouteStep"("tenantId", "routeId", "seq");

-- CreateIndex
CREATE INDEX "RouteTemplate_tenantId_companyId_status_idx" ON "RouteTemplate"("tenantId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RouteTemplate_tenantId_id_key" ON "RouteTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RouteTemplateStep_tenantId_templateId_seq_key" ON "RouteTemplateStep"("tenantId", "templateId", "seq");

-- CreateIndex
CREATE INDEX "SalesOrderLineRoute_tenantId_salesOrderId_idx" ON "SalesOrderLineRoute"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "SalesOrderLineRoute_tenantId_styleRouteId_idx" ON "SalesOrderLineRoute"("tenantId", "styleRouteId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLineRoute_tenantId_salesOrderLineId_key" ON "SalesOrderLineRoute"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "LabourRate_tenantId_companyId_workCentreKind_departmentId_v_key" ON "LabourRate"("tenantId", "companyId", "workCentreKind", "departmentId", "validFrom");

-- AddForeignKey
ALTER TABLE "LabourRate" ADD CONSTRAINT "LabourRate_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "Department"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRoute" ADD CONSTRAINT "StyleRoute_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRoute" ADD CONSTRAINT "StyleRoute_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRoute" ADD CONSTRAINT "StyleRoute_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRouteStep" ADD CONSTRAINT "StyleRouteStep_tenantId_revisionId_routeId_fkey" FOREIGN KEY ("tenantId", "revisionId", "routeId") REFERENCES "StyleRoute"("tenantId", "revisionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRouteStep" ADD CONSTRAINT "StyleRouteStep_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "Department"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRouteStep" ADD CONSTRAINT "StyleRouteStep_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteTemplate" ADD CONSTRAINT "RouteTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteTemplateStep" ADD CONSTRAINT "RouteTemplateStep_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "RouteTemplate"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteTemplateStep" ADD CONSTRAINT "RouteTemplateStep_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "Department"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineRoute" ADD CONSTRAINT "SalesOrderLineRoute_tenantId_companyId_partyId_salesOrderI_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineRoute" ADD CONSTRAINT "SalesOrderLineRoute_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineRoute" ADD CONSTRAINT "SalesOrderLineRoute_tenantId_styleRouteId_fkey" FOREIGN KEY ("tenantId", "styleRouteId") REFERENCES "StyleRoute"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

