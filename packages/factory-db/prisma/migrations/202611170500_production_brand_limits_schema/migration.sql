-- CreateEnum
CREATE TYPE "ProductionShareLevel" AS ENUM ('STATUS', 'PROGRESS', 'GATES', 'QUALITY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderChangeRequestKind" ADD VALUE 'RUSH';
ALTER TYPE "OrderChangeRequestKind" ADD VALUE 'HOLD';
ALTER TYPE "OrderChangeRequestKind" ADD VALUE 'RESUME';
ALTER TYPE "OrderChangeRequestKind" ADD VALUE 'SPLIT_SHIPMENT';
ALTER TYPE "OrderChangeRequestKind" ADD VALUE 'SAMPLE_ROUND';

-- AlterTable
ALTER TABLE "OrderFreezeRule" ADD COLUMN     "partyId" UUID;

-- AlterTable
ALTER TABLE "PortalSettings" ADD COLUMN     "overrideFourEyes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "productionApproverId" UUID,
ADD COLUMN     "productionAskKinds" "OrderChangeRequestKind"[] DEFAULT ARRAY[]::"OrderChangeRequestKind"[],
ADD COLUMN     "productionBackupId" UUID,
ADD COLUMN     "productionLevel" "ProductionShareLevel" NOT NULL DEFAULT 'STATUS',
ADD COLUMN     "productionSupervisorId" UUID,
ADD COLUMN     "productionSupervisorSetAt" TIMESTAMPTZ(3),
ADD COLUMN     "productionUrgencyOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "productionUrgentMax" INTEGER NOT NULL DEFAULT 3;

-- CreateIndex
CREATE INDEX "OrderFreezeRule_tenantId_partyId_field_idx" ON "OrderFreezeRule"("tenantId", "partyId", "field");

-- CreateIndex
CREATE INDEX "PortalSettings_tenantId_productionSupervisorId_idx" ON "PortalSettings"("tenantId", "productionSupervisorId");

-- AddForeignKey
ALTER TABLE "PortalSettings" ADD CONSTRAINT "PortalSettings_tenantId_productionSupervisorId_fkey" FOREIGN KEY ("tenantId", "productionSupervisorId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalSettings" ADD CONSTRAINT "PortalSettings_tenantId_productionBackupId_fkey" FOREIGN KEY ("tenantId", "productionBackupId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalSettings" ADD CONSTRAINT "PortalSettings_tenantId_productionApproverId_fkey" FOREIGN KEY ("tenantId", "productionApproverId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderFreezeRule" ADD CONSTRAINT "OrderFreezeRule_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

