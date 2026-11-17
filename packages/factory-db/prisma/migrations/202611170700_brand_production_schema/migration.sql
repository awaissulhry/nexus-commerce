-- CreateEnum
CREATE TYPE "BrandStage" AS ENUM ('PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY');

-- CreateEnum
CREATE TYPE "BrandHealth" AS ENUM ('LATE', 'AT_RISK', 'NO_DATE', 'ON_TRACK');

-- CreateEnum
CREATE TYPE "HealthReason" AS ENUM ('MATERIAL_LATE', 'CAPACITY', 'QUALITY', 'YOUR_CHANGE', 'TRANSPORT', 'PLANNING');

-- CreateEnum
CREATE TYPE "WaitingOn" AS ENUM ('BRAND', 'SUPPLIER', 'WORKSHOP', 'US');

-- CreateEnum
CREATE TYPE "BrandUrgency" AS ENUM ('URGENT', 'REGULAR');

-- CreateEnum
CREATE TYPE "UrgencyActor" AS ENUM ('BRAND', 'FACTORY');

-- CreateEnum
CREATE TYPE "IssueSource" AS ENUM ('BRAND', 'OFFICE');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'ANSWERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkOrderHoldKind" AS ENUM ('PRODUCTION', 'BRAND');

-- CreateEnum
CREATE TYPE "WorkOrderHoldStatus" AS ENUM ('ACTIVE', 'LIFTED');

-- AlterEnum
ALTER TYPE "PartnerEmailTopic" ADD VALUE 'PRODUCTION';

-- AlterEnum
ALTER TYPE "ReasonList" ADD VALUE 'PRODUCTION_HOLD';

-- CreateTable
CREATE TABLE "BrandOrderProduction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "stage" "BrandStage" NOT NULL DEFAULT 'PREPARING',
    "stageAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "health" "BrandHealth",
    "healthAt" TIMESTAMPTZ(3),
    "healthSet" "BrandHealth",
    "healthReasonCode" "HealthReason",
    "healthNote" TEXT,
    "healthSetAt" TIMESTAMPTZ(3),
    "healthSetById" UUID,
    "healthSetUntil" DATE,
    "waitingOn" "WaitingOn",
    "waitingSince" TIMESTAMPTZ(3),
    "urgency" "BrandUrgency" NOT NULL DEFAULT 'REGULAR',
    "urgentRank" INTEGER,
    "urgencySetAt" TIMESTAMPTZ(3),
    "urgencySetBy" "UrgencyActor",
    "urgencySetById" UUID,
    "urgencyBatchId" UUID,
    "urgencyLocked" BOOLEAN NOT NULL DEFAULT false,
    "urgencyLockReason" TEXT,
    "urgencyLockedAt" TIMESTAMPTZ(3),
    "urgencyLockedById" UUID,
    "supervisorId" UUID,
    "supervisorAssignedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BrandOrderProduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionIssue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "partyId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "salesOrderId" UUID,
    "taskId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "source" "IssueSource" NOT NULL,
    "batchId" UUID,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "raisedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATE NOT NULL,
    "answeredAt" TIMESTAMPTZ(3),
    "escalationStep" INTEGER NOT NULL DEFAULT 0,
    "escalatedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductionIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderHold" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "partyId" UUID,
    "kind" "WorkOrderHoldKind" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "brandWords" TEXT,
    "requestId" UUID,
    "status" "WorkOrderHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "placedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedById" UUID NOT NULL,
    "liftedAt" TIMESTAMPTZ(3),
    "liftedById" UUID,
    "liftReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrandOrderProduction_tenantId_salesOrderId_idx" ON "BrandOrderProduction"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "BrandOrderProduction_tenantId_partyId_urgency_urgentRank_idx" ON "BrandOrderProduction"("tenantId", "partyId", "urgency", "urgentRank");

-- CreateIndex
CREATE INDEX "BrandOrderProduction_tenantId_urgencyBatchId_idx" ON "BrandOrderProduction"("tenantId", "urgencyBatchId");

-- CreateIndex
CREATE INDEX "BrandOrderProduction_tenantId_supervisorId_idx" ON "BrandOrderProduction"("tenantId", "supervisorId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandOrderProduction_tenantId_key_key" ON "BrandOrderProduction"("tenantId", "key");

-- CreateIndex
CREATE INDEX "ProductionIssue_tenantId_salesOrderId_status_idx" ON "ProductionIssue"("tenantId", "salesOrderId", "status");

-- CreateIndex
CREATE INDEX "ProductionIssue_tenantId_status_dueDate_idx" ON "ProductionIssue"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "ProductionIssue_tenantId_taskId_idx" ON "ProductionIssue"("tenantId", "taskId");

-- CreateIndex
CREATE INDEX "ProductionIssue_tenantId_batchId_idx" ON "ProductionIssue"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "ProductionIssue_tenantId_recordType_recordId_idx" ON "ProductionIssue"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "WorkOrderHold_tenantId_workOrderId_status_idx" ON "WorkOrderHold"("tenantId", "workOrderId", "status");

-- CreateIndex
CREATE INDEX "WorkOrderHold_tenantId_partyId_status_idx" ON "WorkOrderHold"("tenantId", "partyId", "status");

-- AddForeignKey
ALTER TABLE "BrandOrderProduction" ADD CONSTRAINT "BrandOrderProduction_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BrandOrderProduction" ADD CONSTRAINT "BrandOrderProduction_tenantId_companyId_partyId_salesOrder_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BrandOrderProduction" ADD CONSTRAINT "BrandOrderProduction_tenantId_supervisorId_fkey" FOREIGN KEY ("tenantId", "supervisorId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductionIssue" ADD CONSTRAINT "ProductionIssue_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductionIssue" ADD CONSTRAINT "ProductionIssue_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderHold" ADD CONSTRAINT "WorkOrderHold_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

