-- CreateEnum
CREATE TYPE "ScrapApprovalStatus" AS ENUM ('WAITING', 'APPROVED', 'REFUSED');

-- CreateEnum
CREATE TYPE "ScrapDecidedOn" AS ENUM ('FLOOR', 'OFFICE');

-- CreateEnum
CREATE TYPE "ScrapFault" AS ENUM ('OWN', 'OTHERS', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'COUPON';

-- AlterTable
ALTER TABLE "BomLine" ADD COLUMN     "routingSeq" INTEGER;

-- AlterTable
ALTER TABLE "HelpCall" ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "requestedQuantity" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "OffStandardEntry" ADD COLUMN     "workOrderId" UUID;

-- AlterTable
ALTER TABLE "ProductionSettings" ADD COLUMN     "qualificationRule" "FloorRuleMode" NOT NULL DEFAULT 'WARN';

-- AlterTable
ALTER TABLE "RoutingOperation" ADD COLUMN     "parallelGroup" INTEGER;

-- AlterTable
ALTER TABLE "ScrapReason" ADD COLUMN     "fault" "ScrapFault" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "WorkOrderOperation" ADD COLUMN     "operationId" UUID,
ADD COLUMN     "parallelGroup" INTEGER,
ADD COLUMN     "unplannedReason" TEXT,
ALTER COLUMN "routingSeq" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ScrapApproval" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "limitPieces" INTEGER NOT NULL,
    "status" "ScrapApprovalStatus" NOT NULL DEFAULT 'WAITING',
    "decidedOn" "ScrapDecidedOn",
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "reasonCode" TEXT,
    "note" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ScrapApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScrapApproval_tenantId_siteId_status_idx" ON "ScrapApproval"("tenantId", "siteId", "status");

-- CreateIndex
CREATE INDEX "ScrapApproval_tenantId_scanId_idx" ON "ScrapApproval"("tenantId", "scanId");

-- CreateIndex
CREATE UNIQUE INDEX "ScrapApproval_tenantId_key_key" ON "ScrapApproval"("tenantId", "key");

-- CreateIndex
CREATE INDEX "OffStandardEntry_tenantId_workOrderId_idx" ON "OffStandardEntry"("tenantId", "workOrderId");

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScrapApproval" ADD CONSTRAINT "ScrapApproval_tenantId_siteId_scanId_fkey" FOREIGN KEY ("tenantId", "siteId", "scanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_revisionId_routingSeq_fkey" FOREIGN KEY ("tenantId", "revisionId", "routingSeq") REFERENCES "RoutingOperation"("tenantId", "revisionId", "seq") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderOperation" ADD CONSTRAINT "WorkOrderOperation_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

