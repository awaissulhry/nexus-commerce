-- AlterEnum
ALTER TYPE "PlanningExceptionKind" ADD VALUE 'WORKSHOP_OVERLOADED';

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "workOrderSizeId" UUID;

-- AlterTable
ALTER TABLE "WorkOrderOperation" ADD COLUMN     "plannedQuantity" INTEGER;

-- CreateTable
CREATE TABLE "StyleCuttingLoss" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "lossPct" DECIMAL(5,2) NOT NULL,
    "basedOnCuts" INTEGER NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleCuttingLoss_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StyleCuttingLoss_tenantId_styleId_decidedAt_idx" ON "StyleCuttingLoss"("tenantId", "styleId", "decidedAt");

-- AddForeignKey
ALTER TABLE "StyleCuttingLoss" ADD CONSTRAINT "StyleCuttingLoss_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

