-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "clientEventId" TEXT;

-- AlterTable
ALTER TABLE "Hide" ADD COLUMN     "closingCutLogId" UUID;

-- AlterTable
ALTER TABLE "ProductionSettings" ADD COLUMN     "standardBundleSize" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "labelPrinterId" UUID;

-- CreateTable
CREATE TABLE "BundleReprint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "replacedCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "printerId" UUID,
    "deviceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BundleReprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BundleReprint_tenantId_bundleId_idx" ON "BundleReprint"("tenantId", "bundleId");

-- CreateIndex
CREATE INDEX "BundleReprint_tenantId_workOrderId_idx" ON "BundleReprint"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_tenantId_clientEventId_key" ON "Bundle"("tenantId", "clientEventId");

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_tenantId_companyId_siteId_labelPrinterId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "labelPrinterId") REFERENCES "Printer"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Hide" ADD CONSTRAINT "Hide_tenantId_siteId_closingCutLogId_fkey" FOREIGN KEY ("tenantId", "siteId", "closingCutLogId") REFERENCES "CutLog"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleReprint" ADD CONSTRAINT "BundleReprint_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleReprint" ADD CONSTRAINT "BundleReprint_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleReprint" ADD CONSTRAINT "BundleReprint_tenantId_companyId_siteId_printerId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "printerId") REFERENCES "Printer"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleReprint" ADD CONSTRAINT "BundleReprint_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

