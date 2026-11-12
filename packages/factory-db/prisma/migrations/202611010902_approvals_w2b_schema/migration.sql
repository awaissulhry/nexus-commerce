-- CreateEnum
CREATE TYPE "ApprovalTaskKind" AS ENUM ('PURCHASE_ORDER', 'PURCHASE_ORDER_CHANGE', 'SALES_ORDER', 'SALES_ORDER_CHANGE', 'PRICE_CHANGE', 'STOCK_ADJUSTMENT', 'COUNT_VARIANCE', 'MATERIAL_SUBSTITUTION', 'CREDIT_OVERRIDE', 'CREDIT_WITHOUT_RETURN', 'SUPPLIER_BANK_CHANGE', 'PURCHASE_REQUEST');

-- CreateEnum
CREATE TYPE "ApprovalMeaning" AS ENUM ('REVIEWED', 'APPROVED', 'RELEASED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "ApprovalTaskStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE');

-- CreateEnum
CREATE TYPE "ApprovalEventAction" AS ENUM ('REQUESTED', 'COMMENTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE', 'SIGNED');

-- AlterEnum
ALTER TYPE "ReasonList" ADD VALUE 'APPROVAL_REJECT';

-- CreateTable
CREATE TABLE "ApprovalRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "kind" "ApprovalTaskKind" NOT NULL,
    "name" TEXT NOT NULL,
    "condition" JSONB NOT NULL,
    "approverRoleId" UUID,
    "approverUserId" UUID,
    "signatureMeaning" "ApprovalMeaning",
    "requireStepUp" BOOLEAN NOT NULL DEFAULT false,
    "sequence" INTEGER NOT NULL DEFAULT 100,
    "dueHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "ApprovalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalTask" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "kind" "ApprovalTaskKind" NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "ruleIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "summary" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "requestedById" UUID,
    "requestedByWorkerId" UUID,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approverRoleId" UUID,
    "approverUserId" UUID,
    "signatureMeaning" "ApprovalMeaning",
    "requireStepUp" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" TIMESTAMPTZ(3),
    "status" "ApprovalTaskStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "comment" TEXT,
    "rejectReasonCode" TEXT,
    "rejectReason" TEXT,
    "stepUpAt" TIMESTAMPTZ(3),
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,
    "staleAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ApprovalTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "taskId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "action" "ApprovalEventAction" NOT NULL,
    "byId" UUID,
    "byWorkerId" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "words" TEXT,
    "reasonCode" TEXT,
    "meaning" "ApprovalMeaning",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalRule_tenantId_kind_active_idx" ON "ApprovalRule"("tenantId", "kind", "active");

-- CreateIndex
CREATE INDEX "ApprovalRule_tenantId_companyId_idx" ON "ApprovalRule"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "ApprovalTask_tenantId_status_approverRoleId_idx" ON "ApprovalTask"("tenantId", "status", "approverRoleId");

-- CreateIndex
CREATE INDEX "ApprovalTask_tenantId_status_approverUserId_idx" ON "ApprovalTask"("tenantId", "status", "approverUserId");

-- CreateIndex
CREATE INDEX "ApprovalTask_tenantId_requestedById_status_idx" ON "ApprovalTask"("tenantId", "requestedById", "status");

-- CreateIndex
CREATE INDEX "ApprovalTask_tenantId_recordType_recordId_idx" ON "ApprovalTask"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "ApprovalTask_tenantId_companyId_status_idx" ON "ApprovalTask"("tenantId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalTask_tenantId_companyId_id_key" ON "ApprovalTask"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "ApprovalEvent_tenantId_recordType_recordId_at_idx" ON "ApprovalEvent"("tenantId", "recordType", "recordId", "at");

-- CreateIndex
CREATE INDEX "ApprovalEvent_tenantId_taskId_idx" ON "ApprovalEvent"("tenantId", "taskId");

-- AddForeignKey
ALTER TABLE "ApprovalRule" ADD CONSTRAINT "ApprovalRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRule" ADD CONSTRAINT "ApprovalRule_tenantId_approverRoleId_fkey" FOREIGN KEY ("tenantId", "approverRoleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRule" ADD CONSTRAINT "ApprovalRule_tenantId_approverUserId_fkey" FOREIGN KEY ("tenantId", "approverUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_tenantId_siteId_requestedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "requestedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_tenantId_approverRoleId_fkey" FOREIGN KEY ("tenantId", "approverRoleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_tenantId_approverUserId_fkey" FOREIGN KEY ("tenantId", "approverUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_tenantId_companyId_taskId_fkey" FOREIGN KEY ("tenantId", "companyId", "taskId") REFERENCES "ApprovalTask"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

