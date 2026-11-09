-- CreateEnum
CREATE TYPE "ShadeRule" AS ENUM ('ORDER', 'GARMENT', 'OFF');

-- AlterTable
ALTER TABLE "GarmentDowngrade" ADD COLUMN     "moveId" UUID;

-- AlterTable
ALTER TABLE "InProcessCheck" ADD COLUMN     "dueAt" TIMESTAMPTZ(3),
ADD COLUMN     "inspectedCount" INTEGER,
ADD COLUMN     "openedByTriggerId" UUID,
ADD COLUMN     "sampleSize" INTEGER;

-- AlterTable
ALTER TABLE "IncomingInspection" ADD COLUMN     "inspectedCount" INTEGER,
ADD COLUMN     "openedByTriggerId" UUID;

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "inspectedCount" INTEGER,
ADD COLUMN     "openedByTriggerId" UUID;

-- AlterTable
ALTER TABLE "InspectionTrigger" ADD COLUMN     "dueHours" INTEGER;

-- AlterTable
ALTER TABLE "ProductionSettings" ADD COLUMN     "hidePhotoRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minimumRemnantArea" DECIMAL(18,4) NOT NULL DEFAULT 10,
ADD COLUMN     "minimumRemnantUom" "Uom" NOT NULL DEFAULT 'DM2',
ADD COLUMN     "shadeRule" "ShadeRule" NOT NULL DEFAULT 'ORDER';

-- AlterTable
ALTER TABLE "PurchasingSettings" ADD COLUMN     "leatherAreaTolerancePct" DECIMAL(7,4);

-- AlterTable
ALTER TABLE "QualitySettings" ADD COLUMN     "severityTexts" JSONB;

-- CreateIndex
CREATE INDEX "GarmentDowngrade_tenantId_moveId_idx" ON "GarmentDowngrade"("tenantId", "moveId");

-- CreateIndex
CREATE INDEX "InProcessCheck_tenantId_status_dueAt_idx" ON "InProcessCheck"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "InProcessCheck_tenantId_openedByTriggerId_idx" ON "InProcessCheck"("tenantId", "openedByTriggerId");

-- CreateIndex
CREATE INDEX "IncomingInspection_tenantId_openedByTriggerId_idx" ON "IncomingInspection"("tenantId", "openedByTriggerId");

-- CreateIndex
CREATE INDEX "Inspection_tenantId_openedByTriggerId_idx" ON "Inspection"("tenantId", "openedByTriggerId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionTrigger_tenantId_companyId_id_key" ON "InspectionTrigger"("tenantId", "companyId", "id");

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_siteId_moveId_fkey" FOREIGN KEY ("tenantId", "siteId", "moveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingInspection" ADD CONSTRAINT "IncomingInspection_tenantId_companyId_openedByTriggerId_fkey" FOREIGN KEY ("tenantId", "companyId", "openedByTriggerId") REFERENCES "InspectionTrigger"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_companyId_openedByTriggerId_fkey" FOREIGN KEY ("tenantId", "companyId", "openedByTriggerId") REFERENCES "InspectionTrigger"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_companyId_openedByTriggerId_fkey" FOREIGN KEY ("tenantId", "companyId", "openedByTriggerId") REFERENCES "InspectionTrigger"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

