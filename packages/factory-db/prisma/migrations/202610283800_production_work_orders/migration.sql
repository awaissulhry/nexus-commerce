-- CreateEnum
CREATE TYPE "ScanSubject" AS ENUM ('WORKER', 'STATION');

-- CreateEnum
CREATE TYPE "MonitoringBasis" AS ENUM ('UNION_AGREEMENT', 'INL_AUTHORISATION', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "WorkOrderKind" AS ENUM ('SIZE_GRID', 'MADE_TO_MEASURE');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BundleStatus" AS ENUM ('ACTIVE', 'VOID');

-- CreateEnum
CREATE TYPE "ScanKind" AS ENUM ('REPORT', 'UNDO', 'CORRECTION');

-- CreateEnum
CREATE TYPE "NoticeAckChannel" AS ENUM ('DEVICE', 'PAPER');

-- CreateTable
CREATE TABLE "ProductionSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "scanSubject" "ScanSubject" NOT NULL DEFAULT 'WORKER',
    "monitoringBasis" "MonitoringBasis",
    "monitoringReference" TEXT,
    "monitoringRecordedAt" TIMESTAMPTZ(3),
    "monitoringRecordedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "batchNumber" TEXT,
    "kind" "WorkOrderKind" NOT NULL,
    "styleId" UUID NOT NULL,
    "styleRevisionId" UUID,
    "labelTemplateId" UUID,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDate" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderSize" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "styleId" UUID NOT NULL,
    "colourwayId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "salesOrderLineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "measurementProfileId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderOperation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "styleRevisionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "routingSeq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "standardMinutes" DECIMAL(10,3) NOT NULL,
    "scanRequired" BOOLEAN NOT NULL DEFAULT true,
    "workCentreId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderMaterial" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "styleRevisionId" UUID NOT NULL,
    "bomLineId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "workOrderSizeId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "hideId" UUID NOT NULL,
    "uom" "Uom" NOT NULL,
    "areaUsed" DECIMAL(18,4) NOT NULL,
    "baseAreaUsed" DECIMAL(18,4) NOT NULL,
    "remnantArea" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "baseRemnantArea" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reversalOfId" UUID,
    "note" TEXT,
    "workerId" UUID,
    "stationId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT NOT NULL,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutLogPiece" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "cutLogId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "part" TEXT NOT NULL,
    "pieces" INTEGER NOT NULL,
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutLogPiece_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "replacedCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quantity" INTEGER NOT NULL,
    "part" TEXT,
    "cutLogIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "BundleStatus" NOT NULL DEFAULT 'ACTIVE',
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "deviceId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationScan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderOperationId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "kind" "ScanKind" NOT NULL,
    "correctsId" UUID,
    "goodQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrapQuantity" INTEGER NOT NULL DEFAULT 0,
    "reworkQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrapReason" TEXT,
    "reason" TEXT,
    "approvedById" UUID,
    "workerId" UUID,
    "stationId" UUID,
    "deviceId" UUID,
    "clientScanId" TEXT NOT NULL,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OperationScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerNoticeAck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "noticeSha256" TEXT NOT NULL,
    "channel" "NoticeAckChannel" NOT NULL,
    "deviceId" UUID,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkerNoticeAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionSettings_tenantId_siteId_idx" ON "ProductionSettings"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "WorkOrder_tenantId_status_dueDate_idx" ON "WorkOrder"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_tenantId_companyId_number_key" ON "WorkOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_tenantId_batchNumber_key" ON "WorkOrder"("tenantId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_tenantId_siteId_id_key" ON "WorkOrder"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_tenantId_siteId_styleId_id_key" ON "WorkOrder"("tenantId", "siteId", "styleId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_tenantId_siteId_styleRevisionId_id_key" ON "WorkOrder"("tenantId", "siteId", "styleRevisionId", "id");

-- CreateIndex
CREATE INDEX "WorkOrderSize_tenantId_salesOrderLineId_idx" ON "WorkOrderSize"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderSize_tenantId_workOrderId_colourwayId_size_key" ON "WorkOrderSize"("tenantId", "workOrderId", "colourwayId", "size");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderSize_tenantId_siteId_workOrderId_id_key" ON "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderOperation_tenantId_workOrderId_seq_key" ON "WorkOrderOperation"("tenantId", "workOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderOperation_tenantId_siteId_workOrderId_id_key" ON "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "WorkOrderMaterial_tenantId_workOrderId_idx" ON "WorkOrderMaterial"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "CutLog_tenantId_hideId_idx" ON "CutLog"("tenantId", "hideId");

-- CreateIndex
CREATE UNIQUE INDEX "CutLog_tenantId_deviceId_clientEventId_key" ON "CutLog"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "CutLog_tenantId_siteId_id_key" ON "CutLog"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CutLog_tenantId_siteId_workOrderId_id_key" ON "CutLog"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CutLogPiece_tenantId_cutLogId_workOrderSizeId_part_key" ON "CutLogPiece"("tenantId", "cutLogId", "workOrderSizeId", "part");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_tenantId_code_key" ON "Bundle"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_tenantId_siteId_workOrderId_id_key" ON "Bundle"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "OperationScan_tenantId_bundleId_workOrderOperationId_idx" ON "OperationScan"("tenantId", "bundleId", "workOrderOperationId");

-- CreateIndex
CREATE INDEX "OperationScan_tenantId_workOrderId_idx" ON "OperationScan"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationScan_tenantId_deviceId_clientScanId_key" ON "OperationScan"("tenantId", "deviceId", "clientScanId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationScan_tenantId_siteId_id_key" ON "OperationScan"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerNoticeAck_tenantId_workerId_noticeVersion_key" ON "WorkerNoticeAck"("tenantId", "workerId", "noticeVersion");

-- AddForeignKey
ALTER TABLE "ProductionSettings" ADD CONSTRAINT "ProductionSettings_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_styleId_styleRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "styleRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_labelTemplateId_fkey" FOREIGN KEY ("tenantId", "labelTemplateId") REFERENCES "LabelTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderSize" ADD CONSTRAINT "WorkOrderSize_tenantId_siteId_styleId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "styleId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderSize" ADD CONSTRAINT "WorkOrderSize_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderSize" ADD CONSTRAINT "WorkOrderSize_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderSize" ADD CONSTRAINT "WorkOrderSize_tenantId_partyId_measurementProfileId_fkey" FOREIGN KEY ("tenantId", "partyId", "measurementProfileId") REFERENCES "MeasurementProfile"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderOperation" ADD CONSTRAINT "WorkOrderOperation_tenantId_siteId_styleRevisionId_workOrd_fkey" FOREIGN KEY ("tenantId", "siteId", "styleRevisionId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "styleRevisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderOperation" ADD CONSTRAINT "WorkOrderOperation_tenantId_styleRevisionId_routingSeq_fkey" FOREIGN KEY ("tenantId", "styleRevisionId", "routingSeq") REFERENCES "RoutingOperation"("tenantId", "revisionId", "seq") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderOperation" ADD CONSTRAINT "WorkOrderOperation_tenantId_siteId_workCentreId_fkey" FOREIGN KEY ("tenantId", "siteId", "workCentreId") REFERENCES "WorkCentre"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderMaterial" ADD CONSTRAINT "WorkOrderMaterial_tenantId_siteId_styleRevisionId_workOrde_fkey" FOREIGN KEY ("tenantId", "siteId", "styleRevisionId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "styleRevisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderMaterial" ADD CONSTRAINT "WorkOrderMaterial_tenantId_styleRevisionId_bomLineId_itemI_fkey" FOREIGN KEY ("tenantId", "styleRevisionId", "bomLineId", "itemId") REFERENCES "BomLine"("tenantId", "revisionId", "id", "itemId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderMaterial" ADD CONSTRAINT "WorkOrderMaterial_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderMaterial" ADD CONSTRAINT "WorkOrderMaterial_tenantId_siteId_workOrderId_workOrderSiz_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_siteId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "siteId", "reversalOfId") REFERENCES "CutLog"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLogPiece" ADD CONSTRAINT "CutLogPiece_tenantId_siteId_workOrderId_cutLogId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "cutLogId") REFERENCES "CutLog"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLogPiece" ADD CONSTRAINT "CutLogPiece_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_workOrderId_workOrderOperati_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_correctsId_fkey" FOREIGN KEY ("tenantId", "siteId", "correctsId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerNoticeAck" ADD CONSTRAINT "WorkerNoticeAck_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerNoticeAck" ADD CONSTRAINT "WorkerNoticeAck_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

