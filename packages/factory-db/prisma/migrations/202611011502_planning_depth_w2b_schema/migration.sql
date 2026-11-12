-- CreateEnum
CREATE TYPE "PlannedOrderKind" AS ENUM ('MAKE', 'SUBCONTRACT');

-- CreateEnum
CREATE TYPE "PlannedOrderStatus" AS ENUM ('PLANNED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "MrpAction" AS ENUM ('EXPEDITE', 'DEFER', 'CANCEL', 'INCREASE', 'DECREASE', 'NEW');

-- CreateEnum
CREATE TYPE "MrpActionStatus" AS ENUM ('OPEN', 'DONE', 'IGNORED');

-- CreateEnum
CREATE TYPE "PromiseKind" AS ENUM ('FIRST', 'RE_PROMISE');

-- CreateEnum
CREATE TYPE "ScheduleChangeKind" AS ENUM ('PLACE', 'MOVE', 'REMOVE', 'PIN', 'UNPIN', 'PUBLISH', 'UNDO');

-- CreateEnum
CREATE TYPE "WhatIfStatus" AS ENUM ('DRAFT', 'APPLIED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "SubcontractCapacityUnit" AS ENUM ('MINUTES', 'PIECES');

-- CreateEnum
CREATE TYPE "ItemLotSizing" AS ENUM ('LOT_FOR_LOT', 'FIXED', 'MIN_MAX', 'PERIOD');

-- CreateEnum
CREATE TYPE "ItemPlanLevel" AS ENUM ('STYLE', 'STYLE_COLOUR', 'SKU');

-- CreateEnum
CREATE TYPE "ProductionStrategy" AS ENUM ('MAKE_TO_ORDER', 'MAKE_TO_STOCK', 'ASSEMBLE_TO_ORDER');

-- CreateEnum
CREATE TYPE "SizeRunRule" AS ENUM ('ONE_GRID', 'SIZE_GROUPS');

-- AlterTable
ALTER TABLE "ItemPlanning" ADD COLUMN     "delayDays" INTEGER,
ADD COLUMN     "fixedLotQty" DECIMAL(18,4),
ADD COLUMN     "lotPeriodDays" INTEGER,
ADD COLUMN     "lotSizing" "ItemLotSizing" NOT NULL DEFAULT 'LOT_FOR_LOT',
ADD COLUMN     "phantom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "planLevel" "ItemPlanLevel",
ADD COLUMN     "scrapPct" DECIMAL(5,2),
ADD COLUMN     "strategy" "ProductionStrategy",
ADD COLUMN     "yieldPct" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "MaterialRequirement" ADD COLUMN     "orderSpecific" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reservedForLineId" UUID,
ADD COLUMN     "reservedForPartyId" UUID;

-- AlterTable
ALTER TABLE "PlanningRun" ADD COLUMN     "inputs" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "PlanningSettings" ADD COLUMN     "sizeGroups" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sizeRunRule" "SizeRunRule" NOT NULL DEFAULT 'ONE_GRID';

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "backlogRank" INTEGER;

-- AlterTable
ALTER TABLE "ScheduleSlot" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedAt" TIMESTAMPTZ(3),
ADD COLUMN     "pinnedById" UUID;

-- AlterTable
ALTER TABLE "SubcontractOrder" ADD COLUMN     "kitDueAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "WorkOrderOperation" ADD COLUMN     "outsourced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subcontractOrderId" UUID;

-- CreateTable
CREATE TABLE "PlannedWorkOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "kind" "PlannedOrderKind" NOT NULL,
    "styleId" UUID NOT NULL,
    "colourwayId" UUID NOT NULL,
    "styleRevisionId" UUID,
    "sizes" JSONB NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sizeGroup" TEXT,
    "startDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "demand" JSONB NOT NULL DEFAULT '[]',
    "lineId" UUID,
    "partyId" UUID,
    "operationSeqs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "kitDueAt" TIMESTAMPTZ(3),
    "firm" BOOLEAN NOT NULL DEFAULT false,
    "firmedAt" TIMESTAMPTZ(3),
    "firmedById" UUID,
    "protectedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "protectedById" UUID,
    "protectedAt" TIMESTAMPTZ(3),
    "status" "PlannedOrderStatus" NOT NULL DEFAULT 'PLANNED',
    "workOrderId" UUID,
    "subcontractOrderId" UUID,
    "convertedAt" TIMESTAMPTZ(3),
    "convertedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PlannedWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MrpActionMessage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "action" "MrpAction" NOT NULL,
    "fromDate" DATE,
    "toDate" DATE,
    "fromQuantity" DECIMAL(18,4),
    "toQuantity" DECIMAL(18,4),
    "uom" "Uom",
    "message" TEXT NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "status" "MrpActionStatus" NOT NULL DEFAULT 'OPEN',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MrpActionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromiseRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "salesOrderLineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "size" TEXT,
    "promisedDate" DATE NOT NULL,
    "kind" "PromiseKind" NOT NULL,
    "reasonCode" TEXT,
    "reason" TEXT,
    "promisedById" UUID NOT NULL,
    "promisedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID,
    "planVersionId" UUID,
    "customerToldAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PromiseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "planVersionId" UUID NOT NULL,
    "kind" "ScheduleChangeKind" NOT NULL,
    "slotId" UUID,
    "workOrderId" UUID,
    "workOrderOperationId" UUID,
    "fromLineId" UUID,
    "fromWorkCentreId" UUID,
    "fromPartyId" UUID,
    "fromStartAt" TIMESTAMPTZ(3),
    "fromEndAt" TIMESTAMPTZ(3),
    "toLineId" UUID,
    "toWorkCentreId" UUID,
    "toPartyId" UUID,
    "toStartAt" TIMESTAMPTZ(3),
    "toEndAt" TIMESTAMPTZ(3),
    "publishedVersionId" UUID,
    "undoesChangeId" UUID,
    "whatIfScenarioId" UUID,
    "reason" TEXT,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ScheduleChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatIfScenario" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT,
    "basePlanVersionId" UUID NOT NULL,
    "basedAt" TIMESTAMPTZ(3) NOT NULL,
    "moves" JSONB NOT NULL DEFAULT '[]',
    "status" "WhatIfStatus" NOT NULL DEFAULT 'DRAFT',
    "appliedAt" TIMESTAMPTZ(3),
    "appliedById" UUID,
    "discardedAt" TIMESTAMPTZ(3),
    "discardedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WhatIfScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractorCapacity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "workCentreKind" "WorkCentreKind",
    "unit" "SubcontractCapacityUnit" NOT NULL,
    "perWeek" INTEGER NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractorCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlannedWorkOrder_tenantId_runId_idx" ON "PlannedWorkOrder"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "PlannedWorkOrder_tenantId_siteId_status_idx" ON "PlannedWorkOrder"("tenantId", "siteId", "status");

-- CreateIndex
CREATE INDEX "PlannedWorkOrder_tenantId_workOrderId_idx" ON "PlannedWorkOrder"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "MrpActionMessage_tenantId_recordType_recordId_idx" ON "MrpActionMessage"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "MrpActionMessage_tenantId_runId_seq_key" ON "MrpActionMessage"("tenantId", "runId", "seq");

-- CreateIndex
CREATE INDEX "PromiseRecord_tenantId_salesOrderLineId_promisedAt_idx" ON "PromiseRecord"("tenantId", "salesOrderLineId", "promisedAt");

-- CreateIndex
CREATE INDEX "ScheduleChange_tenantId_planVersionId_changedAt_idx" ON "ScheduleChange"("tenantId", "planVersionId", "changedAt");

-- CreateIndex
CREATE INDEX "ScheduleChange_tenantId_slotId_idx" ON "ScheduleChange"("tenantId", "slotId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleChange_tenantId_siteId_id_key" ON "ScheduleChange"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "WhatIfScenario_tenantId_siteId_ownerId_status_idx" ON "WhatIfScenario"("tenantId", "siteId", "ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatIfScenario_tenantId_siteId_id_key" ON "WhatIfScenario"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "SubcontractorCapacity_tenantId_partyId_validFrom_idx" ON "SubcontractorCapacity"("tenantId", "partyId", "validFrom");

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_siteId_runId_fkey" FOREIGN KEY ("tenantId", "siteId", "runId") REFERENCES "PlanningRun"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_styleId_styleRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "styleRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlannedWorkOrder" ADD CONSTRAINT "PlannedWorkOrder_tenantId_siteId_workOrderId_subcontractOr_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MrpActionMessage" ADD CONSTRAINT "MrpActionMessage_tenantId_siteId_runId_fkey" FOREIGN KEY ("tenantId", "siteId", "runId") REFERENCES "PlanningRun"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PromiseRecord" ADD CONSTRAINT "PromiseRecord_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PromiseRecord" ADD CONSTRAINT "PromiseRecord_tenantId_siteId_planVersionId_fkey" FOREIGN KEY ("tenantId", "siteId", "planVersionId") REFERENCES "PlanVersion"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_tenantId_siteId_planVersionId_fkey" FOREIGN KEY ("tenantId", "siteId", "planVersionId") REFERENCES "PlanVersion"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_tenantId_siteId_publishedVersionId_fkey" FOREIGN KEY ("tenantId", "siteId", "publishedVersionId") REFERENCES "PlanVersion"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_tenantId_siteId_workOrderId_workOrderOperat_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_tenantId_siteId_undoesChangeId_fkey" FOREIGN KEY ("tenantId", "siteId", "undoesChangeId") REFERENCES "ScheduleChange"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleChange" ADD CONSTRAINT "ScheduleChange_tenantId_siteId_whatIfScenarioId_fkey" FOREIGN KEY ("tenantId", "siteId", "whatIfScenarioId") REFERENCES "WhatIfScenario"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhatIfScenario" ADD CONSTRAINT "WhatIfScenario_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhatIfScenario" ADD CONSTRAINT "WhatIfScenario_tenantId_siteId_basePlanVersionId_fkey" FOREIGN KEY ("tenantId", "siteId", "basePlanVersionId") REFERENCES "PlanVersion"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractorCapacity" ADD CONSTRAINT "SubcontractorCapacity_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderOperation" ADD CONSTRAINT "WorkOrderOperation_tenantId_siteId_workOrderId_subcontract_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_reservedForPartyId_reservedFo_fkey" FOREIGN KEY ("tenantId", "reservedForPartyId", "reservedForLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

