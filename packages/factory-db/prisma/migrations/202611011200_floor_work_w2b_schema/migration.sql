-- CreateEnum
CREATE TYPE "HelpCallKind" AS ENUM ('MACHINE', 'MATERIAL', 'QUALITY', 'SUPERVISOR', 'MAINTENANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "HelpCallStatus" AS ENUM ('SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HandoverTopic" AS ENUM ('PROBLEMS', 'HALF_DONE_BUNDLES', 'MACHINES', 'MATERIAL', 'QUALITY', 'OTHER');

-- CreateEnum
CREATE TYPE "DeviceMode" AS ENUM ('STATION', 'LINE', 'DISPLAY', 'PHONE');

-- CreateEnum
CREATE TYPE "ChecklistOutcome" AS ENUM ('DONE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "OffStandardKind" AS ENUM ('OFF_STANDARD', 'INDIRECT');

-- CreateEnum
CREATE TYPE "OffStandardPayRule" AS ENUM ('AVERAGE', 'BASE', 'UNPAID');

-- CreateEnum
CREATE TYPE "OffStandardSource" AS ENUM ('FLOOR', 'LEAD', 'HELP_CALL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OffStandardStatus" AS ENUM ('OPEN', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LabourDayStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LabourDisputeStatus" AS ENUM ('OPEN', 'UPHELD', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'VOID');

-- CreateEnum
CREATE TYPE "ScanPatternKind" AS ENUM ('BUNCHED_AT_SHIFT_END', 'MOVED_NOT_SCANNED', 'GAP_BELOW_STANDARD');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FloorRuleMode" AS ENUM ('FREE', 'WARN', 'STRICT');

-- CreateEnum
CREATE TYPE "BundleCodeMode" AS ENUM ('ONE_CODE', 'COUPON_PER_OPERATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScanKind" ADD VALUE 'START';
ALTER TYPE "ScanKind" ADD VALUE 'PAUSE';
ALTER TYPE "ScanKind" ADD VALUE 'RESUME';
ALTER TYPE "ScanKind" ADD VALUE 'HAND_BACK';
ALTER TYPE "ScanKind" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "lineId" UUID,
ADD COLUMN     "mode" "DeviceMode" NOT NULL DEFAULT 'STATION',
ADD COLUMN     "personalWorkerId" UUID;

-- AlterTable
ALTER TABLE "OperationScan" ADD COLUMN     "pauseReasonCode" TEXT;

-- AlterTable
ALTER TABLE "ProductionSettings" ADD COLUMN     "bundleCodeMode" "BundleCodeMode" NOT NULL DEFAULT 'ONE_CODE',
ADD COLUMN     "quantityGuard" "FloorRuleMode" NOT NULL DEFAULT 'STRICT',
ADD COLUMN     "scrapApprovalLimit" INTEGER,
ADD COLUMN     "skippedOperationRule" "FloorRuleMode" NOT NULL DEFAULT 'WARN',
ADD COLUMN     "stuckBundleHours" INTEGER NOT NULL DEFAULT 4;

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "rush" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "splitFromId" UUID;

-- CreateTable
CREATE TABLE "HelpCallType" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "HelpCallKind" NOT NULL,
    "responderRecordType" TEXT,
    "responderRecordId" UUID,
    "escalateAfterMinutes" INTEGER,
    "offStandardCodeId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HelpCallType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpCall" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "lineId" UUID,
    "workerId" UUID,
    "workOrderId" UUID,
    "bundleId" UUID,
    "note" TEXT,
    "status" "HelpCallStatus" NOT NULL DEFAULT 'SENT',
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "seenAt" TIMESTAMPTZ(3),
    "seenById" UUID,
    "onTheWayAt" TIMESTAMPTZ(3),
    "onTheWayById" UUID,
    "solvedAt" TIMESTAMPTZ(3),
    "solvedById" UUID,
    "resolutionCode" TEXT,
    "resolutionNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "escalatedAt" TIMESTAMPTZ(3),
    "outcomeRecordType" TEXT,
    "outcomeRecordId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "deviceTime" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HelpCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineTarget" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "targetPieces" INTEGER NOT NULL,
    "shortReasonCode" TEXT,
    "shortNote" TEXT,
    "shortReasonAt" TIMESTAMPTZ(3),
    "shortReasonById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LineTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoverNote" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "shiftDate" DATE NOT NULL,
    "shiftLabel" TEXT NOT NULL,
    "topics" "HandoverTopic"[] DEFAULT ARRAY[]::"HandoverTopic"[],
    "text" TEXT,
    "deviceId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HandoverNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationScanMember" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OperationScanMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationChecklistResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderOperationId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "stepCode" TEXT NOT NULL,
    "outcome" "ChecklistOutcome" NOT NULL DEFAULT 'DONE',
    "workerId" UUID,
    "stationId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OperationChecklistResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OffStandardCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "OffStandardKind" NOT NULL,
    "payRule" "OffStandardPayRule" NOT NULL,
    "needsApproval" BOOLEAN NOT NULL DEFAULT true,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "icon" TEXT,
    "colour" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OffStandardCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OffStandardEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "lineId" UUID,
    "stationId" UUID,
    "workerId" UUID,
    "codeId" UUID NOT NULL,
    "source" "OffStandardSource" NOT NULL,
    "helpCallId" UUID,
    "workDate" DATE NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "status" "OffStandardStatus" NOT NULL DEFAULT 'OPEN',
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectedById" UUID,
    "rejectReason" TEXT,
    "note" TEXT,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "deviceTime" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OffStandardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabourDay" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "status" "LabourDayStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "reopenedAt" TIMESTAMPTZ(3),
    "reopenedById" UUID,
    "reopenReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LabourDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabourEdit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "lineId" UUID,
    "workDate" DATE NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "workerId" UUID,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "disputeId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LabourEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabourDispute" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "lineId" UUID,
    "workDate" DATE NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "status" "LabourDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredAt" TIMESTAMPTZ(3),
    "answeredById" UUID,
    "withdrawnAt" TIMESTAMPTZ(3),
    "deviceId" UUID,
    "clientEventId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LabourDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "lineId" UUID,
    "stationId" UUID,
    "workOrderId" UUID,
    "workOrderOperationId" UUID,
    "bundleIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "workerId" UUID,
    "sequence" INTEGER,
    "overrideReason" TEXT,
    "overrideById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DispatchAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleCoupon" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "workOrderOperationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "replacesId" UUID,
    "deviceId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BundleCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanPatternFinding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "workOrderOperationId" UUID,
    "kind" "ScanPatternKind" NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ScanPatternFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "endReason" "FloorSessionEndReason",
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CrewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewMember" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "crewSessionId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "floorSessionId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL,
    "leftAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CrewMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HelpCallType_tenantId_siteId_code_key" ON "HelpCallType"("tenantId", "siteId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "HelpCallType_tenantId_siteId_id_key" ON "HelpCallType"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "HelpCall_tenantId_siteId_lineId_sentAt_idx" ON "HelpCall"("tenantId", "siteId", "lineId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "HelpCall_tenantId_deviceId_clientEventId_key" ON "HelpCall"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "HelpCall_tenantId_siteId_id_key" ON "HelpCall"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LineTarget_tenantId_lineId_workDate_hour_key" ON "LineTarget"("tenantId", "lineId", "workDate", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "HandoverNote_tenantId_lineId_shiftDate_shiftLabel_key" ON "HandoverNote"("tenantId", "lineId", "shiftDate", "shiftLabel");

-- CreateIndex
CREATE INDEX "OperationScanMember_tenantId_scanId_idx" ON "OperationScanMember"("tenantId", "scanId");

-- CreateIndex
CREATE INDEX "OperationScanMember_tenantId_workerId_idx" ON "OperationScanMember"("tenantId", "workerId");

-- CreateIndex
CREATE INDEX "OperationChecklistResult_tenantId_bundleId_workOrderOperati_idx" ON "OperationChecklistResult"("tenantId", "bundleId", "workOrderOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationChecklistResult_tenantId_deviceId_clientEventId_key" ON "OperationChecklistResult"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "OffStandardCode_tenantId_companyId_code_key" ON "OffStandardCode"("tenantId", "companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OffStandardCode_tenantId_companyId_id_key" ON "OffStandardCode"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "OffStandardEntry_tenantId_lineId_workDate_idx" ON "OffStandardEntry"("tenantId", "lineId", "workDate");

-- CreateIndex
CREATE INDEX "OffStandardEntry_tenantId_workerId_workDate_idx" ON "OffStandardEntry"("tenantId", "workerId", "workDate");

-- CreateIndex
CREATE INDEX "OffStandardEntry_tenantId_helpCallId_idx" ON "OffStandardEntry"("tenantId", "helpCallId");

-- CreateIndex
CREATE UNIQUE INDEX "OffStandardEntry_tenantId_deviceId_clientEventId_key" ON "OffStandardEntry"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "LabourDay_tenantId_lineId_workDate_key" ON "LabourDay"("tenantId", "lineId", "workDate");

-- CreateIndex
CREATE INDEX "LabourEdit_tenantId_recordId_idx" ON "LabourEdit"("tenantId", "recordId");

-- CreateIndex
CREATE INDEX "LabourEdit_tenantId_lineId_workDate_idx" ON "LabourEdit"("tenantId", "lineId", "workDate");

-- CreateIndex
CREATE INDEX "LabourDispute_tenantId_workerId_status_idx" ON "LabourDispute"("tenantId", "workerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LabourDispute_tenantId_deviceId_clientEventId_key" ON "LabourDispute"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "LabourDispute_tenantId_siteId_id_key" ON "LabourDispute"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "DispatchAssignment_tenantId_siteId_workDate_idx" ON "DispatchAssignment"("tenantId", "siteId", "workDate");

-- CreateIndex
CREATE INDEX "DispatchAssignment_tenantId_workerId_workDate_idx" ON "DispatchAssignment"("tenantId", "workerId", "workDate");

-- CreateIndex
CREATE INDEX "DispatchAssignment_tenantId_workOrderOperationId_idx" ON "DispatchAssignment"("tenantId", "workOrderOperationId");

-- CreateIndex
CREATE INDEX "BundleCoupon_tenantId_bundleId_workOrderOperationId_idx" ON "BundleCoupon"("tenantId", "bundleId", "workOrderOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleCoupon_tenantId_code_key" ON "BundleCoupon"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BundleCoupon_tenantId_siteId_workOrderId_id_key" ON "BundleCoupon"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "ScanPatternFinding_tenantId_siteId_status_idx" ON "ScanPatternFinding"("tenantId", "siteId", "status");

-- CreateIndex
CREATE INDEX "ScanPatternFinding_tenantId_bundleId_idx" ON "ScanPatternFinding"("tenantId", "bundleId");

-- CreateIndex
CREATE INDEX "CrewSession_tenantId_deviceId_idx" ON "CrewSession"("tenantId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "CrewSession_tenantId_siteId_id_key" ON "CrewSession"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "CrewMember_tenantId_crewSessionId_idx" ON "CrewMember"("tenantId", "crewSessionId");

-- CreateIndex
CREATE INDEX "CrewMember_tenantId_workerId_idx" ON "CrewMember"("tenantId", "workerId");

-- CreateIndex
CREATE INDEX "OperationScan_tenantId_siteId_workerId_serverTime_idx" ON "OperationScan"("tenantId", "siteId", "workerId", "serverTime");

-- CreateIndex
CREATE INDEX "OperationScan_tenantId_siteId_stationId_serverTime_idx" ON "OperationScan"("tenantId", "siteId", "stationId", "serverTime");

-- CreateIndex
CREATE INDEX "WorkOrder_tenantId_splitFromId_idx" ON "WorkOrder"("tenantId", "splitFromId");

-- AddForeignKey
ALTER TABLE "HelpCallType" ADD CONSTRAINT "HelpCallType_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCallType" ADD CONSTRAINT "HelpCallType_tenantId_companyId_offStandardCodeId_fkey" FOREIGN KEY ("tenantId", "companyId", "offStandardCodeId") REFERENCES "OffStandardCode"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_tenantId_siteId_typeId_fkey" FOREIGN KEY ("tenantId", "siteId", "typeId") REFERENCES "HelpCallType"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineTarget" ADD CONSTRAINT "LineTarget_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HandoverNote" ADD CONSTRAINT "HandoverNote_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HandoverNote" ADD CONSTRAINT "HandoverNote_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_siteId_personalWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "personalWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScanMember" ADD CONSTRAINT "OperationScanMember_tenantId_siteId_scanId_fkey" FOREIGN KEY ("tenantId", "siteId", "scanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScanMember" ADD CONSTRAINT "OperationScanMember_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationChecklistResult" ADD CONSTRAINT "OperationChecklistResult_tenantId_siteId_workOrderId_workO_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationChecklistResult" ADD CONSTRAINT "OperationChecklistResult_tenantId_siteId_workOrderId_bundl_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationChecklistResult" ADD CONSTRAINT "OperationChecklistResult_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationChecklistResult" ADD CONSTRAINT "OperationChecklistResult_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationChecklistResult" ADD CONSTRAINT "OperationChecklistResult_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardCode" ADD CONSTRAINT "OffStandardCode_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_companyId_codeId_fkey" FOREIGN KEY ("tenantId", "companyId", "codeId") REFERENCES "OffStandardCode"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_siteId_helpCallId_fkey" FOREIGN KEY ("tenantId", "siteId", "helpCallId") REFERENCES "HelpCall"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OffStandardEntry" ADD CONSTRAINT "OffStandardEntry_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourDay" ADD CONSTRAINT "LabourDay_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourEdit" ADD CONSTRAINT "LabourEdit_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourEdit" ADD CONSTRAINT "LabourEdit_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourEdit" ADD CONSTRAINT "LabourEdit_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourEdit" ADD CONSTRAINT "LabourEdit_tenantId_siteId_disputeId_fkey" FOREIGN KEY ("tenantId", "siteId", "disputeId") REFERENCES "LabourDispute"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourDispute" ADD CONSTRAINT "LabourDispute_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourDispute" ADD CONSTRAINT "LabourDispute_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabourDispute" ADD CONSTRAINT "LabourDispute_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_tenantId_siteId_workOrderId_workOrderOp_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleCoupon" ADD CONSTRAINT "BundleCoupon_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleCoupon" ADD CONSTRAINT "BundleCoupon_tenantId_siteId_workOrderId_workOrderOperatio_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleCoupon" ADD CONSTRAINT "BundleCoupon_tenantId_siteId_workOrderId_replacesId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "replacesId") REFERENCES "BundleCoupon"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BundleCoupon" ADD CONSTRAINT "BundleCoupon_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanPatternFinding" ADD CONSTRAINT "ScanPatternFinding_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScanPatternFinding" ADD CONSTRAINT "ScanPatternFinding_tenantId_siteId_workOrderId_workOrderOp_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CrewSession" ADD CONSTRAINT "CrewSession_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_tenantId_siteId_crewSessionId_fkey" FOREIGN KEY ("tenantId", "siteId", "crewSessionId") REFERENCES "CrewSession"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_tenantId_siteId_floorSessionId_fkey" FOREIGN KEY ("tenantId", "siteId", "floorSessionId") REFERENCES "FloorSession"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_siteId_splitFromId_fkey" FOREIGN KEY ("tenantId", "siteId", "splitFromId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

