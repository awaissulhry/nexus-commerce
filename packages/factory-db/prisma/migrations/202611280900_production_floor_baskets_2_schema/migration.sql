-- CreateEnum
CREATE TYPE "BasketFlagKind" AS ENUM ('FIRST');

-- CreateEnum
CREATE TYPE "FloorSuggestionKind" AS ENUM ('IDEA', 'WRONG', 'THANKS');

-- AlterTable
ALTER TABLE "FloorSession" ADD COLUMN     "departmentId" UUID,
ADD COLUMN     "stationId" UUID;

-- AlterTable
ALTER TABLE "HelpCall" ADD COLUMN     "spot" INTEGER;

-- AlterTable
ALTER TABLE "OperationChecklistResult" ADD COLUMN     "fileId" UUID;

-- CreateTable
CREATE TABLE "BasketFlag" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "kind" "BasketFlagKind" NOT NULL,
    "setAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setByUserId" UUID,
    "setByWorkerId" UUID,
    "employeeId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "clearedAt" TIMESTAMPTZ(3),
    "clearedByUserId" UUID,
    "clearedByWorkerId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BasketFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorSuggestion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "FloorSuggestionKind" NOT NULL,
    "words" TEXT,
    "voiceFileId" UUID,
    "workerId" UUID,
    "employeeId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloorSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BasketFlag_tenantId_bundleId_setAt_idx" ON "BasketFlag"("tenantId", "bundleId", "setAt");

-- CreateIndex
CREATE INDEX "BasketFlag_tenantId_workOrderId_idx" ON "BasketFlag"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "BasketFlag_tenantId_employeeId_idx" ON "BasketFlag"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "BasketFlag_tenantId_deviceId_clientEventId_bundleId_key" ON "BasketFlag"("tenantId", "deviceId", "clientEventId", "bundleId");

-- CreateIndex
CREATE INDEX "FloorSuggestion_tenantId_siteId_createdAt_idx" ON "FloorSuggestion"("tenantId", "siteId", "createdAt");

-- CreateIndex
CREATE INDEX "FloorSuggestion_tenantId_employeeId_idx" ON "FloorSuggestion"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorSuggestion_tenantId_clientEventId_key" ON "FloorSuggestion"("tenantId", "clientEventId");

-- AddForeignKey
ALTER TABLE "BasketFlag" ADD CONSTRAINT "BasketFlag_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketFlag" ADD CONSTRAINT "BasketFlag_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketFlag" ADD CONSTRAINT "BasketFlag_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketFlag" ADD CONSTRAINT "BasketFlag_tenantId_siteId_setByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "setByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketFlag" ADD CONSTRAINT "BasketFlag_tenantId_siteId_clearedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "clearedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketFlag" ADD CONSTRAINT "BasketFlag_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketFlag" ADD CONSTRAINT "BasketFlag_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSuggestion" ADD CONSTRAINT "FloorSuggestion_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSuggestion" ADD CONSTRAINT "FloorSuggestion_tenantId_voiceFileId_fkey" FOREIGN KEY ("tenantId", "voiceFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSuggestion" ADD CONSTRAINT "FloorSuggestion_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSuggestion" ADD CONSTRAINT "FloorSuggestion_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSuggestion" ADD CONSTRAINT "FloorSuggestion_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSession" ADD CONSTRAINT "FloorSession_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "Department"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSession" ADD CONSTRAINT "FloorSession_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationChecklistResult" ADD CONSTRAINT "OperationChecklistResult_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

