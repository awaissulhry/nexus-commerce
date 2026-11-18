-- CreateEnum
CREATE TYPE "WorkOrderChangeKind" AS ENUM ('LOWER_TO_ORDER', 'MAKE_MORE');

-- CreateEnum
CREATE TYPE "WorkOrderChangeStatus" AS ENUM ('PROPOSED', 'APPLIED', 'DECLINED', 'STALE');

-- CreateEnum
CREATE TYPE "WorkOrderChangeExtraOutcome" AS ENUM ('CHARGE', 'LEFTOVER', 'SCRAP');

-- AlterEnum
ALTER TYPE "OrderChangeRequestKind" ADD VALUE 'DESIGN';

-- AlterTable
ALTER TABLE "ChangeRequest" ADD COLUMN     "orderChangeRequestId" UUID;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "aboutId" UUID,
ADD COLUMN     "aboutKind" TEXT;

-- AlterTable
ALTER TABLE "OrderChangeRequest" ADD COLUMN     "askMessageId" UUID,
ADD COLUMN     "fileIds" UUID[] DEFAULT ('{}'::text)::uuid[];

-- CreateTable
CREATE TABLE "WorkOrderChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "siteId" UUID,
    "workOrderId" UUID,
    "requestId" UUID,
    "amendmentId" UUID,
    "kind" "WorkOrderChangeKind" NOT NULL,
    "cells" JSONB NOT NULL,
    "extra" JSONB,
    "extraOutcome" "WorkOrderChangeExtraOutcome",
    "reason" TEXT NOT NULL,
    "status" "WorkOrderChangeStatus" NOT NULL DEFAULT 'PROPOSED',
    "lastError" TEXT,
    "proposedById" UUID NOT NULL,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionNote" TEXT,
    "madeWorkOrderId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkOrderChange_tenantId_salesOrderId_status_idx" ON "WorkOrderChange"("tenantId", "salesOrderId", "status");

-- CreateIndex
CREATE INDEX "WorkOrderChange_tenantId_workOrderId_status_idx" ON "WorkOrderChange"("tenantId", "workOrderId", "status");

-- CreateIndex
CREATE INDEX "ChangeRequest_tenantId_orderChangeRequestId_idx" ON "ChangeRequest"("tenantId", "orderChangeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_partyId_id_key" ON "Message"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderChangeRequest_tenantId_askMessageId_key" ON "OrderChangeRequest"("tenantId", "askMessageId");

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_partyId_orderChangeRequestId_fkey" FOREIGN KEY ("tenantId", "partyId", "orderChangeRequestId") REFERENCES "OrderChangeRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderChange" ADD CONSTRAINT "WorkOrderChange_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderChange" ADD CONSTRAINT "WorkOrderChange_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderChange" ADD CONSTRAINT "WorkOrderChange_tenantId_partyId_requestId_fkey" FOREIGN KEY ("tenantId", "partyId", "requestId") REFERENCES "OrderChangeRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderChange" ADD CONSTRAINT "WorkOrderChange_tenantId_salesOrderId_amendmentId_fkey" FOREIGN KEY ("tenantId", "salesOrderId", "amendmentId") REFERENCES "SalesOrderAmendment"("tenantId", "orderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_tenantId_partyId_askMessageId_fkey" FOREIGN KEY ("tenantId", "partyId", "askMessageId") REFERENCES "Message"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

