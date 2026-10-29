-- CreateEnum
CREATE TYPE "DefectKind" AS ENUM ('SCRAP', 'REWORK');

-- CreateEnum
CREATE TYPE "ScanCorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REFUSED');

-- CreateEnum
CREATE TYPE "ScanRefusalAction" AS ENUM ('REPORT', 'UNDO', 'ASK_CORRECTION');

-- CreateTable
CREATE TABLE "ScrapReason" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "kind" "DefectKind" NOT NULL,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ScrapReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationScanDefect" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "scanId" UUID,
    "correctionRequestId" UUID,
    "kind" "DefectKind" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OperationScanDefect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanCorrectionRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "workOrderOperationId" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "goodQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrapQuantity" INTEGER NOT NULL DEFAULT 0,
    "reworkQuantity" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" "ScanCorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "askedById" UUID,
    "stationId" UUID,
    "deviceId" UUID,
    "clientRequestId" TEXT NOT NULL,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "correctionScanId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ScanCorrectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorScanRefusal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "clientScanId" TEXT NOT NULL,
    "action" "ScanRefusalAction" NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fix" TEXT NOT NULL,
    "final" BOOLEAN NOT NULL,
    "workOrderId" UUID,
    "bundleId" UUID,
    "workOrderOperationId" UUID,
    "scanned" TEXT,
    "goodQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrapQuantity" INTEGER NOT NULL DEFAULT 0,
    "reworkQuantity" INTEGER NOT NULL DEFAULT 0,
    "workerId" UUID,
    "stationId" UUID,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discardedAt" TIMESTAMPTZ(3),
    "discardedById" UUID,
    "resolvedByScanId" UUID,
    "resolvedByRequestId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FloorScanRefusal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScrapReason_tenantId_kind_code_key" ON "ScrapReason"("tenantId", "kind", "code");

-- CreateIndex
CREATE INDEX "OperationScanDefect_tenantId_scanId_idx" ON "OperationScanDefect"("tenantId", "scanId");

-- CreateIndex
CREATE INDEX "OperationScanDefect_tenantId_correctionRequestId_idx" ON "OperationScanDefect"("tenantId", "correctionRequestId");

-- CreateIndex
CREATE INDEX "OperationScanDefect_tenantId_kind_reasonCode_idx" ON "OperationScanDefect"("tenantId", "kind", "reasonCode");

-- CreateIndex
CREATE INDEX "ScanCorrectionRequest_tenantId_status_siteId_idx" ON "ScanCorrectionRequest"("tenantId", "status", "siteId");

-- CreateIndex
CREATE INDEX "ScanCorrectionRequest_tenantId_scanId_idx" ON "ScanCorrectionRequest"("tenantId", "scanId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanCorrectionRequest_tenantId_deviceId_clientRequestId_key" ON "ScanCorrectionRequest"("tenantId", "deviceId", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanCorrectionRequest_tenantId_siteId_id_key" ON "ScanCorrectionRequest"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "FloorScanRefusal_tenantId_siteId_discardedAt_idx" ON "FloorScanRefusal"("tenantId", "siteId", "discardedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FloorScanRefusal_tenantId_deviceId_clientScanId_code_key" ON "FloorScanRefusal"("tenantId", "deviceId", "clientScanId", "code");

-- AddForeignKey
ALTER TABLE "OperationScanDefect" ADD CONSTRAINT "OperationScanDefect_tenantId_siteId_scanId_fkey" FOREIGN KEY ("tenantId", "siteId", "scanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScanDefect" ADD CONSTRAINT "OperationScanDefect_tenantId_siteId_correctionRequestId_fkey" FOREIGN KEY ("tenantId", "siteId", "correctionRequestId") REFERENCES "ScanCorrectionRequest"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScanDefect" ADD CONSTRAINT "OperationScanDefect_tenantId_kind_reasonCode_fkey" FOREIGN KEY ("tenantId", "kind", "reasonCode") REFERENCES "ScrapReason"("tenantId", "kind", "code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_workOrderId_workOrde_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_scanId_fkey" FOREIGN KEY ("tenantId", "siteId", "scanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_correctionScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "correctionScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_askedById_fkey" FOREIGN KEY ("tenantId", "siteId", "askedById") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanCorrectionRequest" ADD CONSTRAINT "ScanCorrectionRequest_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorScanRefusal" ADD CONSTRAINT "FloorScanRefusal_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorScanRefusal" ADD CONSTRAINT "FloorScanRefusal_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorScanRefusal" ADD CONSTRAINT "FloorScanRefusal_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorScanRefusal" ADD CONSTRAINT "FloorScanRefusal_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorScanRefusal" ADD CONSTRAINT "FloorScanRefusal_tenantId_siteId_resolvedByScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "resolvedByScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

