-- CreateEnum
CREATE TYPE "DataSubjectKind" AS ENUM ('WORKER', 'USER', 'CONTACT', 'PROSPECT', 'REPORTER');

-- CreateEnum
CREATE TYPE "DataRequestKind" AS ENUM ('ACCESS', 'ERASURE', 'CORRECTION');

-- CreateEnum
CREATE TYPE "DataRequestStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'DONE', 'REFUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RetentionAction" AS ENUM ('DELETE', 'ANONYMISE', 'ARCHIVE');

-- CreateEnum
CREATE TYPE "RetentionSweepMode" AS ENUM ('REPORT', 'APPLY');

-- CreateEnum
CREATE TYPE "RetentionSweepStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ErasureMethod" AS ENUM ('ANONYMISED', 'DELETED', 'KEPT');

-- CreateEnum
CREATE TYPE "IntegrationErrorSource" AS ENUM ('OUTBOX', 'WEBHOOK', 'CALL');

-- CreateEnum
CREATE TYPE "IntegrationErrorState" AS ENUM ('OPEN', 'RETRIED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "CronTrigger" AS ENUM ('SCHEDULE', 'RUN_NOW');

-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
ALTER TYPE "PrivacyNoticeKind" ADD VALUE 'SAFETY_REPORT';

-- AlterEnum
ALTER TYPE "ProtectedRecordType" ADD VALUE 'PRODUCT_SAFETY_INJURY';

-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "safetyReportFormOn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DataRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "personKind" "DataSubjectKind" NOT NULL,
    "personRecordType" TEXT NOT NULL,
    "personRecordId" UUID NOT NULL,
    "kind" "DataRequestKind" NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "extendedDueAt" TIMESTAMPTZ(3),
    "extensionReason" TEXT,
    "note" TEXT,
    "identityCheckedAt" TIMESTAMPTZ(3),
    "identityCheckedById" UUID,
    "status" "DataRequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "refusalReason" TEXT,
    "packageFileId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "key" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "keepMonths" INTEGER NOT NULL,
    "thenAction" "RetentionAction" NOT NULL,
    "legalReason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "applyOn" BOOLEAN NOT NULL DEFAULT false,
    "applyOnAt" TIMESTAMPTZ(3),
    "applyOnById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RetentionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionSweep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "ruleId" UUID NOT NULL,
    "mode" "RetentionSweepMode" NOT NULL,
    "keepMonths" INTEGER NOT NULL,
    "thenAction" "RetentionAction" NOT NULL,
    "cutoffOn" DATE NOT NULL,
    "status" "RetentionSweepStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "dueCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "heldCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "failures" JSONB NOT NULL DEFAULT '[]',
    "requestedById" UUID,

    CONSTRAINT "RetentionSweep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErasureRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "dataRequestId" UUID,
    "sweepId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "method" "ErasureMethod" NOT NULL,
    "erasedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keptFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keptWhy" TEXT,
    "erasedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erasedById" UUID,

    CONSTRAINT "ErasureRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationErrorItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "key" TEXT NOT NULL,
    "source" "IntegrationErrorSource" NOT NULL,
    "sourceId" UUID NOT NULL,
    "provider" "IntegrationProvider",
    "operation" TEXT NOT NULL,
    "recordType" TEXT,
    "recordId" UUID,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT,
    "tries" INTEGER NOT NULL DEFAULT 1,
    "firstFailedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastFailedAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "IntegrationErrorState" NOT NULL DEFAULT 'OPEN',
    "retriedAt" TIMESTAMPTZ(3),
    "retriedById" UUID,
    "dismissedAt" TIMESTAMPTZ(3),
    "dismissedById" UUID,
    "dismissReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationErrorItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "jobKey" TEXT NOT NULL,
    "trigger" "CronTrigger" NOT NULL,
    "key" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "requestedById" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "ranOn" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataRequest_tenantId_companyId_status_dueAt_idx" ON "DataRequest"("tenantId", "companyId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "DataRequest_tenantId_personRecordType_personRecordId_idx" ON "DataRequest"("tenantId", "personRecordType", "personRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "DataRequest_tenantId_id_key" ON "DataRequest"("tenantId", "id");

-- CreateIndex
CREATE INDEX "RetentionRule_tenantId_recordType_idx" ON "RetentionRule"("tenantId", "recordType");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionRule_tenantId_key_key" ON "RetentionRule"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionRule_tenantId_id_key" ON "RetentionRule"("tenantId", "id");

-- CreateIndex
CREATE INDEX "RetentionSweep_tenantId_ruleId_startedAt_idx" ON "RetentionSweep"("tenantId", "ruleId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionSweep_tenantId_id_key" ON "RetentionSweep"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ErasureRecord_tenantId_dataRequestId_idx" ON "ErasureRecord"("tenantId", "dataRequestId");

-- CreateIndex
CREATE INDEX "ErasureRecord_tenantId_sweepId_idx" ON "ErasureRecord"("tenantId", "sweepId");

-- CreateIndex
CREATE INDEX "ErasureRecord_tenantId_recordType_recordId_idx" ON "ErasureRecord"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "IntegrationErrorItem_tenantId_state_lastFailedAt_idx" ON "IntegrationErrorItem"("tenantId", "state", "lastFailedAt");

-- CreateIndex
CREATE INDEX "IntegrationErrorItem_tenantId_source_sourceId_idx" ON "IntegrationErrorItem"("tenantId", "source", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationErrorItem_tenantId_key_key" ON "IntegrationErrorItem"("tenantId", "key");

-- CreateIndex
CREATE INDEX "CronRun_tenantId_jobKey_scheduledAt_idx" ON "CronRun"("tenantId", "jobKey", "scheduledAt");

-- CreateIndex
CREATE INDEX "CronRun_tenantId_status_startedAt_idx" ON "CronRun"("tenantId", "status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CronRun_tenantId_key_key" ON "CronRun"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "DataRequest" ADD CONSTRAINT "DataRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DataRequest" ADD CONSTRAINT "DataRequest_tenantId_packageFileId_fkey" FOREIGN KEY ("tenantId", "packageFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RetentionRule" ADD CONSTRAINT "RetentionRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RetentionSweep" ADD CONSTRAINT "RetentionSweep_tenantId_ruleId_fkey" FOREIGN KEY ("tenantId", "ruleId") REFERENCES "RetentionRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ErasureRecord" ADD CONSTRAINT "ErasureRecord_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ErasureRecord" ADD CONSTRAINT "ErasureRecord_tenantId_dataRequestId_fkey" FOREIGN KEY ("tenantId", "dataRequestId") REFERENCES "DataRequest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ErasureRecord" ADD CONSTRAINT "ErasureRecord_tenantId_sweepId_fkey" FOREIGN KEY ("tenantId", "sweepId") REFERENCES "RetentionSweep"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IntegrationErrorItem" ADD CONSTRAINT "IntegrationErrorItem_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

