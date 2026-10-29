-- CreateEnum
CREATE TYPE "GarmentLabelPrintKind" AS ENUM ('PRINT', 'REPRINT');

-- AlterTable
ALTER TABLE "GarmentSerial" ADD COLUMN     "bundleId" UUID;

-- CreateTable
CREATE TABLE "GarmentLabelPrint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "kind" "GarmentLabelPrintKind" NOT NULL,
    "tracking" "GarmentTracking" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "serialIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "reason" TEXT,
    "printerId" UUID,
    "deviceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GarmentLabelPrint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GarmentLabelPrint_tenantId_workOrderId_idx" ON "GarmentLabelPrint"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "GarmentLabelPrint_tenantId_workOrderSizeId_idx" ON "GarmentLabelPrint"("tenantId", "workOrderSizeId");

-- CreateIndex
CREATE INDEX "GarmentSerial_tenantId_bundleId_idx" ON "GarmentSerial"("tenantId", "bundleId");

-- AddForeignKey
ALTER TABLE "GarmentLabelPrint" ADD CONSTRAINT "GarmentLabelPrint_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentLabelPrint" ADD CONSTRAINT "GarmentLabelPrint_tenantId_siteId_workOrderId_workOrderSiz_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentLabelPrint" ADD CONSTRAINT "GarmentLabelPrint_tenantId_companyId_siteId_printerId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "printerId") REFERENCES "Printer"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentLabelPrint" ADD CONSTRAINT "GarmentLabelPrint_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentSerial" ADD CONSTRAINT "GarmentSerial_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

