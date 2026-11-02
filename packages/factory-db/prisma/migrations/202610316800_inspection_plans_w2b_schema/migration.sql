-- CreateEnum
CREATE TYPE "InspectionPlanStage" AS ENUM ('INCOMING', 'CUTTING', 'IN_LINE', 'END_OF_LINE', 'FINAL', 'RETURN');

-- CreateEnum
CREATE TYPE "InspectionPlanVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "InspectionSamplingMethod" AS ENUM ('AQL_PROFILE', 'FIXED');

-- CreateEnum
CREATE TYPE "InspectionFrequency" AS ENUM ('EVERY_LOT', 'PERCENT_OF_OPERATIONS', 'FIRST_PIECE', 'EVERY_NTH_BUNDLE');

-- CreateEnum
CREATE TYPE "InspectionCheckType" AS ENUM ('PASS_FAIL', 'MEASUREMENT', 'COUNT', 'CHOICE', 'FREE_TEXT', 'PHOTO', 'SIGNATURE', 'INSTRUCTION');

-- CreateEnum
CREATE TYPE "InspectionCheckOutcome" AS ENUM ('PASS', 'FAIL', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "AqlInspectionLevel" AS ENUM ('I', 'II', 'III', 'S1', 'S2', 'S3', 'S4');

-- CreateEnum
CREATE TYPE "InspectionTriggerEvent" AS ENUM ('GOODS_RECEIPT', 'OPERATION_FINISHED', 'BUNDLE_SCAN', 'PACKING', 'RETURN_RECEIVED');

-- CreateEnum
CREATE TYPE "IncomingInspectionStatus" AS ENUM ('OPEN', 'DECIDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncomingUnitDecision" AS ENUM ('ACCEPTED', 'REJECTED', 'TO_SORT');

-- CreateEnum
CREATE TYPE "IncomingComponentKind" AS ENUM ('PROTECTOR', 'ZIP', 'REFLECTIVE', 'HARDWARE', 'OTHER');

-- CreateEnum
CREATE TYPE "InProcessCheckKind" AS ENUM ('FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE');

-- CreateEnum
CREATE TYPE "InProcessCheckStatus" AS ENUM ('OPEN', 'DECIDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InProcessOutcome" AS ENUM ('APPROVED', 'REJECTED', 'PASS', 'FAIL', 'GREEN', 'AMBER', 'RED');

-- CreateEnum
CREATE TYPE "InspectionAmendmentKind" AS ENUM ('REQUEST', 'SIGNED', 'REFUSED');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'INCOMING_INSPECTION';

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "aqlProfileId" UUID,
ADD COLUMN     "codeLetter" TEXT,
ADD COLUMN     "planVersionId" UUID;

-- CreateTable
CREATE TABLE "InspectionPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "stage" "InspectionPlanStage" NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" UUID,
    "appliesTo" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionPlanVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "InspectionPlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "changeNote" TEXT,
    "authorId" UUID NOT NULL,
    "samplingMethod" "InspectionSamplingMethod" NOT NULL DEFAULT 'AQL_PROFILE',
    "aqlProfileId" UUID,
    "fixedSampleSize" INTEGER,
    "frequency" "InspectionFrequency",
    "frequencyValue" INTEGER,
    "stopAtReject" BOOLEAN,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvalSha256" TEXT,
    "retiredById" UUID,
    "retiredAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionPlanCheck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "planVersionId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "type" "InspectionCheckType" NOT NULL,
    "checkClass" "DefectClass",
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "photoRequired" BOOLEAN NOT NULL DEFAULT false,
    "nominal" DECIMAL(12,3),
    "tolerance" DECIMAL(12,3),
    "uom" "Uom",
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionPlanCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AqlProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inspectionLevel" "AqlInspectionLevel" NOT NULL,
    "aqlCritical" DECIMAL(7,3) NOT NULL DEFAULT 0,
    "aqlMajor" DECIMAL(7,3) NOT NULL,
    "aqlMinor" DECIMAL(7,3) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AqlProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AqlProfileAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "customerId" UUID,
    "styleId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AqlProfileAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionTrigger" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "event" "InspectionTriggerEvent" NOT NULL,
    "appliesTo" JSONB NOT NULL DEFAULT '[]',
    "planId" UUID NOT NULL,
    "frequency" "InspectionFrequency" NOT NULL,
    "frequencyValue" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingInspection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "lotId" UUID,
    "itemId" UUID,
    "subcontractReceiptId" UUID,
    "workOrderId" UUID,
    "planVersionId" UUID NOT NULL,
    "aqlProfileId" UUID,
    "codeLetter" TEXT,
    "lotSize" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "inspectionLevel" TEXT,
    "aqlMajor" DECIMAL(7,3),
    "aqlMinor" DECIMAL(7,3),
    "acceptMajor" INTEGER,
    "acceptMinor" INTEGER,
    "foundCritical" INTEGER NOT NULL DEFAULT 0,
    "foundMajor" INTEGER NOT NULL DEFAULT 0,
    "foundMinor" INTEGER NOT NULL DEFAULT 0,
    "status" "IncomingInspectionStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedQuantity" DECIMAL(18,4),
    "rejectedQuantity" DECIMAL(18,4),
    "toSortQuantity" DECIMAL(18,4),
    "computedResult" "InspectionResult",
    "overrideReason" TEXT,
    "inspectorWorkerId" UUID,
    "inspectorUserId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "decidedAt" TIMESTAMPTZ(3),
    "signatureSha256" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IncomingInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingHideResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "incomingInspectionId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "hideId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "declaredArea" DECIMAL(18,4),
    "measuredArea" DECIMAL(18,4) NOT NULL,
    "areaUom" "Uom" NOT NULL,
    "shadeGroup" TEXT,
    "shadeRecordType" TEXT,
    "shadeRecordId" UUID,
    "grade" TEXT,
    "gradeRecordType" TEXT,
    "gradeRecordId" UUID,
    "marks" JSONB NOT NULL DEFAULT '[]',
    "decision" "IncomingUnitDecision",
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IncomingHideResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingRollResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "incomingInspectionId" UUID NOT NULL,
    "rollRef" TEXT NOT NULL,
    "recordType" TEXT,
    "recordId" UUID,
    "onePoint" INTEGER NOT NULL DEFAULT 0,
    "twoPoint" INTEGER NOT NULL DEFAULT 0,
    "threePoint" INTEGER NOT NULL DEFAULT 0,
    "fourPoint" INTEGER NOT NULL DEFAULT 0,
    "widthCm" DECIMAL(10,2) NOT NULL,
    "lengthM" DECIMAL(12,2) NOT NULL,
    "pointsPer100SqYd" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "decision" "IncomingUnitDecision",
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IncomingRollResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingComponentResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "incomingInspectionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "IncomingComponentKind" NOT NULL,
    "marking" TEXT,
    "protectorType" TEXT,
    "size" TEXT,
    "certificateId" UUID,
    "checkedQuantity" INTEGER NOT NULL,
    "defectiveQuantity" INTEGER NOT NULL DEFAULT 0,
    "decision" "IncomingUnitDecision",
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IncomingComponentResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InProcessCheck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "InProcessCheckKind" NOT NULL,
    "status" "InProcessCheckStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" "InProcessOutcome",
    "lineId" UUID,
    "workOrderId" UUID,
    "bundleId" UUID,
    "workOrderOperationId" UUID,
    "planVersionId" UUID,
    "aqlProfileId" UUID,
    "codeLetter" TEXT,
    "pieces" INTEGER NOT NULL DEFAULT 0,
    "defectivePieces" INTEGER NOT NULL DEFAULT 0,
    "defects" INTEGER NOT NULL DEFAULT 0,
    "defectCodeId" UUID,
    "inspectorWorkerId" UUID,
    "inspectorUserId" UUID,
    "workerId" UUID,
    "employeeId" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "signatureSha256" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InProcessCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionCheckResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "inspectionId" UUID,
    "incomingInspectionId" UUID,
    "inProcessCheckId" UUID,
    "planCheckId" UUID NOT NULL,
    "sampleIndex" INTEGER NOT NULL DEFAULT 1,
    "outcome" "InspectionCheckOutcome" NOT NULL,
    "value" TEXT,
    "note" TEXT,
    "recordedById" UUID,
    "recordedByWorkerId" UUID,
    "deviceId" UUID,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionCheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionMeasurement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "inspectionId" UUID,
    "incomingInspectionId" UUID,
    "inProcessCheckId" UUID,
    "planCheckId" UUID,
    "pointCode" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '',
    "sampleIndex" INTEGER NOT NULL DEFAULT 1,
    "nominal" DECIMAL(12,3) NOT NULL,
    "tolerance" DECIMAL(12,3) NOT NULL,
    "measured" DECIMAL(12,3) NOT NULL,
    "uom" "Uom" NOT NULL,
    "pass" BOOLEAN NOT NULL DEFAULT false,
    "recordedById" UUID,
    "recordedByWorkerId" UUID,
    "deviceId" UUID,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionAmendment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "inspectionId" UUID,
    "incomingInspectionId" UUID,
    "inProcessCheckId" UUID,
    "kind" "InspectionAmendmentKind" NOT NULL,
    "requestId" UUID,
    "field" TEXT,
    "recordType" TEXT,
    "recordId" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "signedById" UUID NOT NULL,
    "signedAt" TIMESTAMPTZ(3) NOT NULL,
    "signatureSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InspectionPlan_tenantId_companyId_stage_idx" ON "InspectionPlan"("tenantId", "companyId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlan_tenantId_companyId_code_key" ON "InspectionPlan"("tenantId", "companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlan_tenantId_companyId_id_key" ON "InspectionPlan"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "InspectionPlanVersion_tenantId_planId_status_idx" ON "InspectionPlanVersion"("tenantId", "planId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlanVersion_tenantId_planId_number_key" ON "InspectionPlanVersion"("tenantId", "planId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlanVersion_tenantId_companyId_id_key" ON "InspectionPlanVersion"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlanVersion_tenantId_id_key" ON "InspectionPlanVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlanCheck_tenantId_planVersionId_code_key" ON "InspectionPlanCheck"("tenantId", "planVersionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlanCheck_tenantId_id_key" ON "InspectionPlanCheck"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AqlProfile_tenantId_companyId_code_key" ON "AqlProfile"("tenantId", "companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AqlProfile_tenantId_companyId_id_key" ON "AqlProfile"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "AqlProfileAssignment_tenantId_customerId_idx" ON "AqlProfileAssignment"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "AqlProfileAssignment_tenantId_styleId_idx" ON "AqlProfileAssignment"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "AqlProfileAssignment_tenantId_profileId_idx" ON "AqlProfileAssignment"("tenantId", "profileId");

-- CreateIndex
CREATE INDEX "InspectionTrigger_tenantId_companyId_event_sortOrder_idx" ON "InspectionTrigger"("tenantId", "companyId", "event", "sortOrder");

-- CreateIndex
CREATE INDEX "InspectionTrigger_tenantId_planId_idx" ON "InspectionTrigger"("tenantId", "planId");

-- CreateIndex
CREATE INDEX "IncomingInspection_tenantId_lotId_idx" ON "IncomingInspection"("tenantId", "lotId");

-- CreateIndex
CREATE INDEX "IncomingInspection_tenantId_subcontractReceiptId_idx" ON "IncomingInspection"("tenantId", "subcontractReceiptId");

-- CreateIndex
CREATE INDEX "IncomingInspection_tenantId_status_dueAt_idx" ON "IncomingInspection"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingInspection_tenantId_number_key" ON "IncomingInspection"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingInspection_tenantId_siteId_id_key" ON "IncomingInspection"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingInspection_tenantId_siteId_lotId_id_key" ON "IncomingInspection"("tenantId", "siteId", "lotId", "id");

-- CreateIndex
CREATE INDEX "IncomingHideResult_tenantId_hideId_idx" ON "IncomingHideResult"("tenantId", "hideId");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingHideResult_tenantId_incomingInspectionId_seq_key" ON "IncomingHideResult"("tenantId", "incomingInspectionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingRollResult_tenantId_incomingInspectionId_rollRef_key" ON "IncomingRollResult"("tenantId", "incomingInspectionId", "rollRef");

-- CreateIndex
CREATE INDEX "IncomingComponentResult_tenantId_certificateId_idx" ON "IncomingComponentResult"("tenantId", "certificateId");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingComponentResult_tenantId_incomingInspectionId_seq_key" ON "IncomingComponentResult"("tenantId", "incomingInspectionId", "seq");

-- CreateIndex
CREATE INDEX "InProcessCheck_tenantId_workOrderId_kind_status_idx" ON "InProcessCheck"("tenantId", "workOrderId", "kind", "status");

-- CreateIndex
CREATE INDEX "InProcessCheck_tenantId_siteId_lineId_kind_idx" ON "InProcessCheck"("tenantId", "siteId", "lineId", "kind");

-- CreateIndex
CREATE INDEX "InProcessCheck_tenantId_employeeId_idx" ON "InProcessCheck"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "InProcessCheck_tenantId_siteId_id_key" ON "InProcessCheck"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "InspectionCheckResult_tenantId_planCheckId_idx" ON "InspectionCheckResult"("tenantId", "planCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCheckResult_tenantId_inspectionId_planCheckId_sam_key" ON "InspectionCheckResult"("tenantId", "inspectionId", "planCheckId", "sampleIndex");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCheckResult_tenantId_incomingInspectionId_planChe_key" ON "InspectionCheckResult"("tenantId", "incomingInspectionId", "planCheckId", "sampleIndex");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCheckResult_tenantId_inProcessCheckId_planCheckId_key" ON "InspectionCheckResult"("tenantId", "inProcessCheckId", "planCheckId", "sampleIndex");

-- CreateIndex
CREATE INDEX "InspectionMeasurement_tenantId_planCheckId_idx" ON "InspectionMeasurement"("tenantId", "planCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionMeasurement_tenantId_inspectionId_pointCode_size__key" ON "InspectionMeasurement"("tenantId", "inspectionId", "pointCode", "size", "sampleIndex");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionMeasurement_tenantId_incomingInspectionId_pointCo_key" ON "InspectionMeasurement"("tenantId", "incomingInspectionId", "pointCode", "size", "sampleIndex");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionMeasurement_tenantId_inProcessCheckId_pointCode_s_key" ON "InspectionMeasurement"("tenantId", "inProcessCheckId", "pointCode", "size", "sampleIndex");

-- CreateIndex
CREATE INDEX "InspectionAmendment_tenantId_inspectionId_idx" ON "InspectionAmendment"("tenantId", "inspectionId");

-- CreateIndex
CREATE INDEX "InspectionAmendment_tenantId_incomingInspectionId_idx" ON "InspectionAmendment"("tenantId", "incomingInspectionId");

-- CreateIndex
CREATE INDEX "InspectionAmendment_tenantId_inProcessCheckId_idx" ON "InspectionAmendment"("tenantId", "inProcessCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionAmendment_tenantId_requestId_key" ON "InspectionAmendment"("tenantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionAmendment_tenantId_siteId_id_key" ON "InspectionAmendment"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_tenantId_siteId_id_key" ON "Inspection"("tenantId", "siteId", "id");

-- AddForeignKey
ALTER TABLE "InspectionPlan" ADD CONSTRAINT "InspectionPlan_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionPlanVersion" ADD CONSTRAINT "InspectionPlanVersion_tenantId_companyId_planId_fkey" FOREIGN KEY ("tenantId", "companyId", "planId") REFERENCES "InspectionPlan"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionPlanVersion" ADD CONSTRAINT "InspectionPlanVersion_tenantId_companyId_aqlProfileId_fkey" FOREIGN KEY ("tenantId", "companyId", "aqlProfileId") REFERENCES "AqlProfile"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionPlanCheck" ADD CONSTRAINT "InspectionPlanCheck_tenantId_planVersionId_fkey" FOREIGN KEY ("tenantId", "planVersionId") REFERENCES "InspectionPlanVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AqlProfile" ADD CONSTRAINT "AqlProfile_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AqlProfileAssignment" ADD CONSTRAINT "AqlProfileAssignment_tenantId_companyId_profileId_fkey" FOREIGN KEY ("tenantId", "companyId", "profileId") REFERENCES "AqlProfile"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AqlProfileAssignment" ADD CONSTRAINT "AqlProfileAssignment_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AqlProfileAssignment" ADD CONSTRAINT "AqlProfileAssignment_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionTrigger" ADD CONSTRAINT "InspectionTrigger_tenantId_companyId_planId_fkey" FOREIGN KEY ("tenantId", "companyId", "planId") REFERENCES "InspectionPlan"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingInspection" ADD CONSTRAINT "IncomingInspection_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingInspection" ADD CONSTRAINT "IncomingInspection_tenantId_companyId_planVersionId_fkey" FOREIGN KEY ("tenantId", "companyId", "planVersionId") REFERENCES "InspectionPlanVersion"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingInspection" ADD CONSTRAINT "IncomingInspection_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingInspection" ADD CONSTRAINT "IncomingInspection_tenantId_siteId_workOrderId_subcontract_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractReceiptId") REFERENCES "SubcontractReceipt"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingInspection" ADD CONSTRAINT "IncomingInspection_tenantId_companyId_aqlProfileId_fkey" FOREIGN KEY ("tenantId", "companyId", "aqlProfileId") REFERENCES "AqlProfile"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingInspection" ADD CONSTRAINT "IncomingInspection_tenantId_siteId_inspectorWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "inspectorWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingHideResult" ADD CONSTRAINT "IncomingHideResult_tenantId_siteId_lotId_incomingInspectio_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingHideResult" ADD CONSTRAINT "IncomingHideResult_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingRollResult" ADD CONSTRAINT "IncomingRollResult_tenantId_siteId_incomingInspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingComponentResult" ADD CONSTRAINT "IncomingComponentResult_tenantId_siteId_incomingInspection_fkey" FOREIGN KEY ("tenantId", "siteId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncomingComponentResult" ADD CONSTRAINT "IncomingComponentResult_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_siteId_workOrderId_workOrderOperat_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_companyId_planVersionId_fkey" FOREIGN KEY ("tenantId", "companyId", "planVersionId") REFERENCES "InspectionPlanVersion"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_companyId_aqlProfileId_fkey" FOREIGN KEY ("tenantId", "companyId", "aqlProfileId") REFERENCES "AqlProfile"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_defectCodeId_fkey" FOREIGN KEY ("tenantId", "defectCodeId") REFERENCES "DefectCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_siteId_inspectorWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "inspectorWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InProcessCheck" ADD CONSTRAINT "InProcessCheck_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionCheckResult" ADD CONSTRAINT "InspectionCheckResult_tenantId_siteId_inspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "inspectionId") REFERENCES "Inspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionCheckResult" ADD CONSTRAINT "InspectionCheckResult_tenantId_siteId_incomingInspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionCheckResult" ADD CONSTRAINT "InspectionCheckResult_tenantId_siteId_inProcessCheckId_fkey" FOREIGN KEY ("tenantId", "siteId", "inProcessCheckId") REFERENCES "InProcessCheck"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionCheckResult" ADD CONSTRAINT "InspectionCheckResult_tenantId_planCheckId_fkey" FOREIGN KEY ("tenantId", "planCheckId") REFERENCES "InspectionPlanCheck"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionCheckResult" ADD CONSTRAINT "InspectionCheckResult_tenantId_siteId_recordedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "recordedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionCheckResult" ADD CONSTRAINT "InspectionCheckResult_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionMeasurement" ADD CONSTRAINT "InspectionMeasurement_tenantId_siteId_inspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "inspectionId") REFERENCES "Inspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionMeasurement" ADD CONSTRAINT "InspectionMeasurement_tenantId_siteId_incomingInspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionMeasurement" ADD CONSTRAINT "InspectionMeasurement_tenantId_siteId_inProcessCheckId_fkey" FOREIGN KEY ("tenantId", "siteId", "inProcessCheckId") REFERENCES "InProcessCheck"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionMeasurement" ADD CONSTRAINT "InspectionMeasurement_tenantId_planCheckId_fkey" FOREIGN KEY ("tenantId", "planCheckId") REFERENCES "InspectionPlanCheck"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionMeasurement" ADD CONSTRAINT "InspectionMeasurement_tenantId_siteId_recordedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "recordedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionMeasurement" ADD CONSTRAINT "InspectionMeasurement_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionAmendment" ADD CONSTRAINT "InspectionAmendment_tenantId_siteId_inspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "inspectionId") REFERENCES "Inspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionAmendment" ADD CONSTRAINT "InspectionAmendment_tenantId_siteId_incomingInspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionAmendment" ADD CONSTRAINT "InspectionAmendment_tenantId_siteId_inProcessCheckId_fkey" FOREIGN KEY ("tenantId", "siteId", "inProcessCheckId") REFERENCES "InProcessCheck"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionAmendment" ADD CONSTRAINT "InspectionAmendment_tenantId_siteId_requestId_fkey" FOREIGN KEY ("tenantId", "siteId", "requestId") REFERENCES "InspectionAmendment"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_companyId_planVersionId_fkey" FOREIGN KEY ("tenantId", "companyId", "planVersionId") REFERENCES "InspectionPlanVersion"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_companyId_aqlProfileId_fkey" FOREIGN KEY ("tenantId", "companyId", "aqlProfileId") REFERENCES "AqlProfile"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

