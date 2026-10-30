-- CreateEnum
CREATE TYPE "ItemPlanningMethod" AS ENUM ('ORDERS', 'REORDER_POINT', 'MIN_MAX', 'MANUAL');

-- CreateEnum
CREATE TYPE "ItemPlanningSource" AS ENUM ('BUY', 'MAKE');

-- CreateEnum
CREATE TYPE "PeggingDemandKind" AS ENUM ('ORDER_LINE', 'WORK_ORDER', 'SAFETY_STOCK', 'REORDER');

-- CreateEnum
CREATE TYPE "PeggingSupplyKind" AS ENUM ('STOCK', 'RESERVATION', 'PURCHASE_ORDER', 'PLANNED');

-- CreateEnum
CREATE TYPE "PlanningExceptionKind" AS ENUM ('SHORT', 'SUPPLY_LATE', 'LANE_OVERLOADED', 'LANE_UNDERUSED', 'PAST_DUE', 'EXCESS', 'BELOW_SAFETY_STOCK', 'MOVE_EARLIER', 'MOVE_LATER', 'CANCEL', 'NEGATIVE_STOCK');

-- CreateEnum
CREATE TYPE "PlanningExceptionStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "PlanningExceptionResolution" AS ENUM ('HANDLED', 'CLEARED');

-- CreateEnum
CREATE TYPE "ReservationKind" AS ENUM ('QUANTITY', 'AREA', 'HIDE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'ISSUED', 'RELEASED');

-- CreateEnum
CREATE TYPE "StockCountKind" AS ENUM ('CYCLE', 'YEAR_END');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED', 'APPLIED', 'SIGNED_OFF', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockCountLineOrigin" AS ENUM ('SNAPSHOT', 'ADDED');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'COUNT';

-- AlterTable
ALTER TABLE "MaterialRequirement" ADD COLUMN     "firmBaseQuantity" DECIMAL(18,4),
ADD COLUMN     "firmCarriedFromId" UUID,
ADD COLUMN     "firmDate" DATE,
ADD COLUMN     "firmQuantity" DECIMAL(18,4),
ADD COLUMN     "firmSupplierId" UUID,
ADD COLUMN     "firmedAt" TIMESTAMPTZ(3),
ADD COLUMN     "firmedById" UUID;

-- CreateTable
CREATE TABLE "PlanningSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "horizonWeeks" INTEGER NOT NULL DEFAULT 26,
    "dayBucketWeeks" INTEGER NOT NULL DEFAULT 2,
    "weekBucketWeeks" INTEGER NOT NULL DEFAULT 13,
    "defaultEfficiencyPct" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "scheduledRunTime" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PlanningSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemPlanning" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "method" "ItemPlanningMethod" NOT NULL DEFAULT 'ORDERS',
    "source" "ItemPlanningSource",
    "supplierId" UUID,
    "makeSiteId" UUID,
    "buyLeadTimeDays" INTEGER,
    "makeLeadTimeDays" INTEGER,
    "safetyLeadTimeDays" INTEGER,
    "safetyStock" DECIMAL(18,4),
    "reorderPoint" DECIMAL(18,4),
    "lotSize" DECIMAL(18,4),
    "minStock" DECIMAL(18,4),
    "maxStock" DECIMAL(18,4),
    "minOrderQty" DECIMAL(18,4),
    "orderMultiple" DECIMAL(18,4),
    "maxOrderQty" DECIMAL(18,4),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ItemPlanning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineCapacity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "plannedEfficiencyPct" DECIMAL(5,2) NOT NULL,
    "operators" INTEGER,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LineCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkCentreCapacity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workCentreId" UUID NOT NULL,
    "units" INTEGER,
    "plannedEfficiencyPct" DECIMAL(5,2) NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkCentreCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementPegging" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "requirementId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "demandKind" "PeggingDemandKind" NOT NULL,
    "salesOrderLineId" UUID,
    "partyId" UUID,
    "size" TEXT,
    "workOrderId" UUID,
    "demandDate" DATE NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "supplyKind" "PeggingSupplyKind" NOT NULL,
    "reservationId" UUID,
    "purchaseOrderLineId" UUID,
    "supplyDate" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RequirementPegging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "PlanningExceptionKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "firstRunId" UUID NOT NULL,
    "lastRunId" UUID NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "itemId" UUID,
    "itemColourId" UUID,
    "requirementId" UUID,
    "recordType" TEXT,
    "recordId" UUID,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "ordersAffected" INTEGER NOT NULL DEFAULT 0,
    "daysLate" INTEGER,
    "status" "PlanningExceptionStatus" NOT NULL DEFAULT 'NEW',
    "ownerId" UUID,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedById" UUID,
    "snoozedAt" TIMESTAMPTZ(3),
    "snoozedById" UUID,
    "snoozedUntil" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "resolution" "PlanningExceptionResolution",
    "resolveNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PlanningException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "ReservationKind" NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotId" UUID,
    "hideId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "issuedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "workOrderId" UUID,
    "salesOrderLineId" UUID,
    "partyId" UUID,
    "needDate" DATE,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "releaseReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "StockCountKind" NOT NULL,
    "locationId" UUID,
    "itemId" UUID,
    "lotId" UUID,
    "itemKind" "ItemKind",
    "inventoryDate" DATE,
    "countTeam" TEXT,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMPTZ(3),
    "snapshotAt" TIMESTAMPTZ(3),
    "submittedAt" TIMESTAMPTZ(3),
    "submittedById" UUID,
    "differenceAmount" INTEGER,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "approvalNote" TEXT,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectedById" UUID,
    "rejectReason" TEXT,
    "appliedAt" TIMESTAMPTZ(3),
    "appliedById" UUID,
    "signedOffAt" TIMESTAMPTZ(3),
    "signedOffById" UUID,
    "valuedListFileId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "countId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "locationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotId" UUID,
    "hideId" UUID,
    "origin" "StockCountLineOrigin" NOT NULL DEFAULT 'SNAPSHOT',
    "expectedQuantity" DECIMAL(18,4) NOT NULL,
    "countedQuantity" DECIMAL(18,4),
    "countedAt" TIMESTAMPTZ(3),
    "countedById" UUID,
    "recountRequestedAt" TIMESTAMPTZ(3),
    "recountRequestedById" UUID,
    "recountQuantity" DECIMAL(18,4),
    "recountedAt" TIMESTAMPTZ(3),
    "recountedById" UUID,
    "reasonCode" TEXT,
    "reasonNote" TEXT,
    "moveId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanningSettings_tenantId_siteId_idx" ON "PlanningSettings"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "ItemPlanning_tenantId_siteId_itemId_idx" ON "ItemPlanning"("tenantId", "siteId", "itemId");

-- CreateIndex
CREATE INDEX "LineCapacity_tenantId_siteId_idx" ON "LineCapacity"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "WorkCentreCapacity_tenantId_siteId_idx" ON "WorkCentreCapacity"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "RequirementPegging_tenantId_runId_idx" ON "RequirementPegging"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "RequirementPegging_tenantId_salesOrderLineId_idx" ON "RequirementPegging"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE INDEX "RequirementPegging_tenantId_workOrderId_idx" ON "RequirementPegging"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "RequirementPegging_tenantId_requirementId_seq_key" ON "RequirementPegging"("tenantId", "requirementId", "seq");

-- CreateIndex
CREATE INDEX "PlanningException_tenantId_siteId_status_idx" ON "PlanningException"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlanningException_tenantId_siteId_dedupeKey_occurrence_key" ON "PlanningException"("tenantId", "siteId", "dedupeKey", "occurrence");

-- CreateIndex
CREATE INDEX "Reservation_tenantId_siteId_itemId_status_idx" ON "Reservation"("tenantId", "siteId", "itemId", "status");

-- CreateIndex
CREATE INDEX "Reservation_tenantId_workOrderId_idx" ON "Reservation"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "Reservation_tenantId_salesOrderLineId_idx" ON "Reservation"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_tenantId_siteId_id_key" ON "Reservation"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "StockCount_tenantId_siteId_status_idx" ON "StockCount"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_tenantId_companyId_number_key" ON "StockCount"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_tenantId_siteId_id_key" ON "StockCount"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "StockCountLine_tenantId_siteId_itemId_lotId_hideId_idx" ON "StockCountLine"("tenantId", "siteId", "itemId", "lotId", "hideId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_tenantId_countId_seq_key" ON "StockCountLine"("tenantId", "countId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialRequirement_tenantId_siteId_id_key" ON "MaterialRequirement"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialRequirement_tenantId_siteId_runId_id_key" ON "MaterialRequirement"("tenantId", "siteId", "runId", "id");

-- AddForeignKey
ALTER TABLE "PlanningSettings" ADD CONSTRAINT "PlanningSettings_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemPlanning" ADD CONSTRAINT "ItemPlanning_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemPlanning" ADD CONSTRAINT "ItemPlanning_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemPlanning" ADD CONSTRAINT "ItemPlanning_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemPlanning" ADD CONSTRAINT "ItemPlanning_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemPlanning" ADD CONSTRAINT "ItemPlanning_tenantId_companyId_makeSiteId_fkey" FOREIGN KEY ("tenantId", "companyId", "makeSiteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineCapacity" ADD CONSTRAINT "LineCapacity_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineCapacity" ADD CONSTRAINT "LineCapacity_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCentreCapacity" ADD CONSTRAINT "WorkCentreCapacity_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCentreCapacity" ADD CONSTRAINT "WorkCentreCapacity_tenantId_siteId_workCentreId_fkey" FOREIGN KEY ("tenantId", "siteId", "workCentreId") REFERENCES "WorkCentre"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequirementPegging" ADD CONSTRAINT "RequirementPegging_tenantId_siteId_runId_requirementId_fkey" FOREIGN KEY ("tenantId", "siteId", "runId", "requirementId") REFERENCES "MaterialRequirement"("tenantId", "siteId", "runId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequirementPegging" ADD CONSTRAINT "RequirementPegging_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequirementPegging" ADD CONSTRAINT "RequirementPegging_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequirementPegging" ADD CONSTRAINT "RequirementPegging_tenantId_siteId_reservationId_fkey" FOREIGN KEY ("tenantId", "siteId", "reservationId") REFERENCES "Reservation"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequirementPegging" ADD CONSTRAINT "RequirementPegging_tenantId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanningException" ADD CONSTRAINT "PlanningException_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanningException" ADD CONSTRAINT "PlanningException_tenantId_siteId_firstRunId_fkey" FOREIGN KEY ("tenantId", "siteId", "firstRunId") REFERENCES "PlanningRun"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanningException" ADD CONSTRAINT "PlanningException_tenantId_siteId_lastRunId_fkey" FOREIGN KEY ("tenantId", "siteId", "lastRunId") REFERENCES "PlanningRun"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanningException" ADD CONSTRAINT "PlanningException_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanningException" ADD CONSTRAINT "PlanningException_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanningException" ADD CONSTRAINT "PlanningException_tenantId_siteId_requirementId_fkey" FOREIGN KEY ("tenantId", "siteId", "requirementId") REFERENCES "MaterialRequirement"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_siteId_locationId_fkey" FOREIGN KEY ("tenantId", "siteId", "locationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_valuedListFileId_fkey" FOREIGN KEY ("tenantId", "valuedListFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_siteId_countId_fkey" FOREIGN KEY ("tenantId", "siteId", "countId") REFERENCES "StockCount"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_siteId_locationId_fkey" FOREIGN KEY ("tenantId", "siteId", "locationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_siteId_moveId_fkey" FOREIGN KEY ("tenantId", "siteId", "moveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_firmSupplierId_fkey" FOREIGN KEY ("tenantId", "firmSupplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_siteId_firmCarriedFromId_fkey" FOREIGN KEY ("tenantId", "siteId", "firmCarriedFromId") REFERENCES "MaterialRequirement"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

