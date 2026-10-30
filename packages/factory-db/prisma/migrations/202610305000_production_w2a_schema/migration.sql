-- CreateEnum
CREATE TYPE "ReworkStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReplacementKind" AS ENUM ('RECUT', 'REDUCE');

-- CreateEnum
CREATE TYPE "ReplacementStatus" AS ENUM ('OPEN', 'APPROVED', 'REFUSED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanVersionKind" AS ENUM ('WORKING', 'PUBLISHED');

-- AlterEnum
ALTER TYPE "ItemKind" ADD VALUE 'FINISHED';

-- AlterEnum
ALTER TYPE "LocationKind" ADD VALUE 'FINISHED_GOODS';

-- AlterEnum
ALTER TYPE "StockMoveReason" ADD VALUE 'PRODUCTION_RECEIPT';

-- AlterEnum
ALTER TYPE "WorkOrderKind" ADD VALUE 'REPAIR';

-- AlterEnum
ALTER TYPE "WorkOrderStatus" ADD VALUE 'ON_HOLD';

-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "parentBundleId" UUID;

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "variantId" UUID;

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "heldAt" TIMESTAMPTZ(3),
ADD COLUMN     "heldById" UUID,
ADD COLUMN     "heldFromStatus" "WorkOrderStatus",
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "holdRecordId" UUID,
ADD COLUMN     "holdRecordType" TEXT,
ADD COLUMN     "lineId" UUID;

-- CreateTable
CREATE TABLE "ReworkOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "bundleId" UUID,
    "sourceScanId" UUID,
    "foundAtOperationId" UUID,
    "reworkAtOperationId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "description" TEXT,
    "recordType" TEXT,
    "recordId" UUID,
    "status" "ReworkStatus" NOT NULL DEFAULT 'OPEN',
    "goodQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrapQuantity" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReworkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplacementRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "kind" "ReplacementKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "part" TEXT,
    "sourceScanId" UUID,
    "reworkOrderId" UUID,
    "recordType" TEXT,
    "recordId" UUID,
    "reason" TEXT NOT NULL,
    "status" "ReplacementStatus" NOT NULL DEFAULT 'OPEN',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionNote" TEXT,
    "cutLogId" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReplacementRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "PlanVersionKind" NOT NULL,
    "number" INTEGER,
    "previousId" UUID,
    "coversFrom" DATE,
    "coversTo" DATE,
    "effectiveFrom" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSlot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "planVersionId" UUID NOT NULL,
    "planKind" "PlanVersionKind" NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderOperationId" UUID,
    "lineId" UUID,
    "workCentreId" UUID,
    "partyId" UUID,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "pieces" INTEGER,
    "minutes" DECIMAL(12,3) NOT NULL,
    "overloadReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "ScheduleSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReworkOrder_tenantId_workOrderId_idx" ON "ReworkOrder"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "ReworkOrder_tenantId_siteId_status_idx" ON "ReworkOrder"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReworkOrder_tenantId_siteId_workOrderId_id_key" ON "ReworkOrder"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "ReplacementRequest_tenantId_workOrderId_idx" ON "ReplacementRequest"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "ReplacementRequest_tenantId_siteId_kind_status_idx" ON "ReplacementRequest"("tenantId", "siteId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_tenantId_siteId_number_key" ON "PlanVersion"("tenantId", "siteId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_tenantId_siteId_id_key" ON "PlanVersion"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_tenantId_siteId_kind_id_key" ON "PlanVersion"("tenantId", "siteId", "kind", "id");

-- CreateIndex
CREATE INDEX "ScheduleSlot_tenantId_planVersionId_startAt_idx" ON "ScheduleSlot"("tenantId", "planVersionId", "startAt");

-- CreateIndex
CREATE INDEX "ScheduleSlot_tenantId_workOrderId_idx" ON "ScheduleSlot"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Item_tenantId_variantId_key" ON "Item"("tenantId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_tenantId_id_key" ON "Variant"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId") REFERENCES "Variant"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_tenantId_siteId_workOrderId_parentBundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "parentBundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_siteId_sourceScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "sourceScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_siteId_workOrderId_foundAtOperationId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "foundAtOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_siteId_workOrderId_reworkAtOperationI_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "reworkAtOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_tenantId_siteId_workOrderId_workOrderSi_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_tenantId_siteId_sourceScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "sourceScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_tenantId_siteId_workOrderId_reworkOrder_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "reworkOrderId") REFERENCES "ReworkOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_tenantId_siteId_workOrderId_cutLogId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "cutLogId") REFERENCES "CutLog"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_tenantId_siteId_previousId_fkey" FOREIGN KEY ("tenantId", "siteId", "previousId") REFERENCES "PlanVersion"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_tenantId_siteId_planKind_planVersionId_fkey" FOREIGN KEY ("tenantId", "siteId", "planKind", "planVersionId") REFERENCES "PlanVersion"("tenantId", "siteId", "kind", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_tenantId_siteId_workOrderId_workOrderOperatio_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_tenantId_siteId_workCentreId_fkey" FOREIGN KEY ("tenantId", "siteId", "workCentreId") REFERENCES "WorkCentre"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

