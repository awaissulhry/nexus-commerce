-- CreateEnum
CREATE TYPE "FileAskTarget" AS ENUM ('SALES_ORDER', 'SALES_ORDER_LINE', 'WORK_ORDER');

-- CreateEnum
CREATE TYPE "FileAskAddressee" AS ENUM ('PERSON', 'OFFICE_ROLE', 'FLOOR_ROLE', 'FLOOR_TEAM', 'STEP');

-- CreateEnum
CREATE TYPE "FileAskStatus" AS ENUM ('OPEN', 'ARRIVED', 'ACCEPTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "FileAsk" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID,
    "salesOrderId" UUID NOT NULL,
    "target" "FileAskTarget" NOT NULL,
    "salesOrderLineId" UUID,
    "workOrderId" UUID,
    "workOrderOperationId" UUID,
    "words" TEXT NOT NULL,
    "fileKind" "FileKind" NOT NULL,
    "priced" BOOLEAN NOT NULL DEFAULT false,
    "bodyData" BOOLEAN NOT NULL DEFAULT false,
    "addressee" "FileAskAddressee" NOT NULL,
    "addresseeUserId" UUID,
    "addresseeRoleId" UUID,
    "addresseeTeamId" UUID,
    "dueOn" DATE NOT NULL,
    "status" "FileAskStatus" NOT NULL DEFAULT 'OPEN',
    "fileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "answeredAt" TIMESTAMPTZ(3),
    "answeredById" UUID,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedById" UUID,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "lastReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "lastChasedAt" TIMESTAMPTZ(3),
    "taskIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "checkTaskId" UUID,
    "askedById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAsk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileAsk_tenantId_salesOrderId_status_idx" ON "FileAsk"("tenantId", "salesOrderId", "status");

-- CreateIndex
CREATE INDEX "FileAsk_tenantId_workOrderId_status_idx" ON "FileAsk"("tenantId", "workOrderId", "status");

-- CreateIndex
CREATE INDEX "FileAsk_tenantId_siteId_status_idx" ON "FileAsk"("tenantId", "siteId", "status");

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_siteId_workOrderId_workOrderOperationId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_siteId_addresseeTeamId_fkey" FOREIGN KEY ("tenantId", "siteId", "addresseeTeamId") REFERENCES "Team"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_addresseeRoleId_fkey" FOREIGN KEY ("tenantId", "addresseeRoleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_addresseeUserId_fkey" FOREIGN KEY ("tenantId", "addresseeUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileAsk" ADD CONSTRAINT "FileAsk_tenantId_askedById_fkey" FOREIGN KEY ("tenantId", "askedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

