-- CreateEnum
CREATE TYPE "SafetyRole" AS ENUM ('EMPLOYER', 'RSPP', 'ASPP', 'DOCTOR', 'RLS', 'RLST', 'SUPERVISOR', 'MANAGER', 'FIRST_AID', 'FIRE_EMERGENCY');

-- CreateEnum
CREATE TYPE "SafetySignMethod" AS ENUM ('OFFICE', 'FLOOR_PIN', 'PAPER');

-- CreateEnum
CREATE TYPE "RlsNoticeStatus" AS ENUM ('PENDING', 'FILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SafetyDeadlineKind" AS ENUM ('DRILL', 'MEETING', 'INSPECTION', 'RENEWAL', 'AUTHORITY_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "SafetyRepeatUnit" AS ENUM ('WEEK', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "SafetyDeadlineStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DvrAuthorKind" AS ENUM ('CONSULTANT', 'IN_HOUSE');

-- CreateEnum
CREATE TYPE "RiskAssessmentVersionStatus" AS ENUM ('AWAITING_SIGNATURES', 'SIGNED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RiskMeasureStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'VERIFIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RiskMeasureSource" AS ENUM ('DVR', 'INCIDENT', 'INSPECTION', 'MEETING', 'OTHER');

-- CreateEnum
CREATE TYPE "RoleSheetItemKind" AS ENUM ('RISK', 'SURVEILLANCE');

-- CreateEnum
CREATE TYPE "SafetyCourseType" AS ENUM ('GENERAL', 'SPECIFIC_LOW', 'SPECIFIC_MEDIUM', 'SPECIFIC_HIGH', 'SUPERVISOR', 'MANAGER', 'RLS', 'FIRST_AID', 'FIRE', 'FORKLIFT', 'OTHER');

-- CreateEnum
CREATE TYPE "TrainingRequirementSource" AS ENUM ('ROLE_SHEET', 'MACHINE_CLASS');

-- CreateEnum
CREATE TYPE "TrainingSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrainingResult" AS ENUM ('PASSED', 'FAILED', 'VOID');

-- CreateEnum
CREATE TYPE "PpeIssueKind" AS ENUM ('ISSUE', 'VOID');

-- CreateEnum
CREATE TYPE "PpeIssueReason" AS ENUM ('NEW', 'REPLACEMENT', 'LOST');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "roleSheetId" UUID;

-- CreateTable
CREATE TABLE "SafetyAppointment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "role" "SafetyRole" NOT NULL,
    "employeeId" UUID,
    "outsideName" TEXT,
    "outsidePartyId" UUID,
    "outsideContactId" UUID,
    "shiftPatternId" UUID,
    "fromDate" DATE NOT NULL,
    "untilDate" DATE,
    "endReason" TEXT,
    "signedAt" TIMESTAMPTZ(3),
    "signMethod" "SafetySignMethod",
    "signedName" TEXT,
    "signedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SafetyAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RlsNotice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "dueOn" DATE NOT NULL,
    "status" "RlsNoticeStatus" NOT NULL DEFAULT 'PENDING',
    "filedOn" DATE,
    "reference" TEXT,
    "filedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RlsNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyDeadline" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "title" TEXT NOT NULL,
    "kind" "SafetyDeadlineKind" NOT NULL,
    "dueOn" DATE NOT NULL,
    "repeatEvery" INTEGER,
    "repeatUnit" "SafetyRepeatUnit",
    "ownerId" UUID,
    "evidenceRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" "SafetyDeadlineStatus" NOT NULL DEFAULT 'OPEN',
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "doneNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "previousId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SafetyDeadline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nextReviewOn" DATE,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAssessmentVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "authorKind" "DvrAuthorKind" NOT NULL,
    "authorName" TEXT NOT NULL,
    "changeSummary" TEXT,
    "fileId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "frozenAt" TIMESTAMPTZ(3) NOT NULL,
    "frozenById" UUID NOT NULL,
    "signersRequired" "SafetyRole"[],
    "status" "RiskAssessmentVersionStatus" NOT NULL DEFAULT 'AWAITING_SIGNATURES',
    "certainDateOn" DATE,
    "signedAt" TIMESTAMPTZ(3),
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RiskAssessmentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAssessmentSignature" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "role" "SafetyRole" NOT NULL,
    "appointmentId" UUID,
    "signerName" TEXT NOT NULL,
    "signedOn" DATE NOT NULL,
    "signedAt" TIMESTAMPTZ(3) NOT NULL,
    "method" "SafetySignMethod" NOT NULL,
    "signedById" UUID,
    "signedByWorkerId" UUID,
    "signatureSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RiskAssessmentSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskMeasure" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "risk" TEXT,
    "roleSheetIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "ownerId" UUID,
    "dueOn" DATE,
    "cost" INTEGER,
    "status" "RiskMeasureStatus" NOT NULL DEFAULT 'PLANNED',
    "source" "RiskMeasureSource" NOT NULL,
    "versionId" UUID,
    "sourceRecordType" TEXT,
    "sourceRecordId" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "evidenceNote" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "verifiedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RiskMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleSheet" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "description" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RoleSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleSheetItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "roleSheetId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "RoleSheetItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RoleSheetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyCourse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "type" "SafetyCourseType" NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "refresherMonths" INTEGER,
    "refresherHours" DECIMAL(6,2),
    "inPersonRequired" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "legalBasis" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SafetyCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingRequirement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "source" "TrainingRequirementSource" NOT NULL,
    "roleSheetId" UUID,
    "machineClassId" UUID,
    "courseId" UUID NOT NULL,
    "withinDays" INTEGER,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TrainingRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "heldOn" DATE NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "language" TEXT NOT NULL,
    "trainerEmployeeId" UUID,
    "trainerName" TEXT NOT NULL,
    "providerPartyId" UUID,
    "location" TEXT,
    "status" "TrainingSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAttendance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" "SafetySignMethod" NOT NULL,
    "signedAt" TIMESTAMPTZ(3) NOT NULL,
    "signedByWorkerId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "signatureSha256" TEXT,
    "countersignedAt" TIMESTAMPTZ(3),
    "countersignMethod" "SafetySignMethod",
    "countersignedByWorkerId" UUID,
    "countersignedById" UUID,
    "languageUnderstood" BOOLEAN,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TrainingAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "sessionId" UUID,
    "attendanceId" UUID,
    "completedOn" DATE NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "trainerName" TEXT NOT NULL,
    "result" "TrainingResult" NOT NULL,
    "validUntil" DATE,
    "validUntilReason" TEXT,
    "language" TEXT NOT NULL,
    "languageChecked" BOOLEAN NOT NULL DEFAULT false,
    "correctsId" UUID,
    "correctionReason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TrainingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstructionRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "instructedOn" DATE NOT NULL,
    "task" TEXT NOT NULL,
    "machineClassId" UUID,
    "machineId" UUID,
    "instructorEmployeeId" UUID,
    "instructorName" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "languageChecked" BOOLEAN NOT NULL DEFAULT false,
    "signedAt" TIMESTAMPTZ(3),
    "signMethod" "SafetySignMethod",
    "signedByWorkerId" UUID,
    "signatureSha256" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InstructionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PpeItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "category" "PpeCategory" NOT NULL,
    "standard" TEXT,
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lifeMonths" INTEGER,
    "supplierPartyId" UUID,
    "unitCost" INTEGER,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PpeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PpeKitLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "roleSheetId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "ppeItemId" UUID NOT NULL,
    "whenToWear" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PpeKitLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PpeIssue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "PpeIssueKind" NOT NULL,
    "employeeId" UUID NOT NULL,
    "ppeItemId" UUID NOT NULL,
    "size" TEXT,
    "quantity" INTEGER NOT NULL,
    "reason" "PpeIssueReason",
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "issuedById" UUID,
    "issuedByWorkerId" UUID,
    "method" "SafetySignMethod",
    "signedByWorkerId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "signatureSha256" TEXT,
    "voidsId" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PpeIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SafetyAppointment_tenantId_companyId_role_idx" ON "SafetyAppointment"("tenantId", "companyId", "role");

-- CreateIndex
CREATE INDEX "SafetyAppointment_tenantId_employeeId_idx" ON "SafetyAppointment"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyAppointment_tenantId_id_key" ON "SafetyAppointment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyAppointment_tenantId_companyId_id_key" ON "SafetyAppointment"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "RlsNotice_tenantId_appointmentId_idx" ON "RlsNotice"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "RlsNotice_tenantId_companyId_status_idx" ON "RlsNotice"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "SafetyDeadline_tenantId_companyId_dueOn_idx" ON "SafetyDeadline"("tenantId", "companyId", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyDeadline_tenantId_id_key" ON "SafetyDeadline"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessment_tenantId_siteId_name_key" ON "RiskAssessment"("tenantId", "siteId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessment_tenantId_companyId_siteId_id_key" ON "RiskAssessment"("tenantId", "companyId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessmentVersion_tenantId_assessmentId_versionNo_key" ON "RiskAssessmentVersion"("tenantId", "assessmentId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessmentVersion_tenantId_companyId_siteId_id_key" ON "RiskAssessmentVersion"("tenantId", "companyId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessmentVersion_tenantId_assessmentId_id_key" ON "RiskAssessmentVersion"("tenantId", "assessmentId", "id");

-- CreateIndex
CREATE INDEX "RiskAssessmentSignature_tenantId_versionId_idx" ON "RiskAssessmentSignature"("tenantId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessmentSignature_tenantId_key_key" ON "RiskAssessmentSignature"("tenantId", "key");

-- CreateIndex
CREATE INDEX "RiskMeasure_tenantId_assessmentId_idx" ON "RiskMeasure"("tenantId", "assessmentId");

-- CreateIndex
CREATE INDEX "RiskMeasure_tenantId_companyId_status_dueOn_idx" ON "RiskMeasure"("tenantId", "companyId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "RoleSheet_tenantId_siteId_code_key" ON "RoleSheet"("tenantId", "siteId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RoleSheet_tenantId_siteId_id_key" ON "RoleSheet"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RoleSheet_tenantId_id_key" ON "RoleSheet"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RoleSheetItem_tenantId_roleSheetId_seq_key" ON "RoleSheetItem"("tenantId", "roleSheetId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyCourse_tenantId_code_key" ON "SafetyCourse"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyCourse_tenantId_id_key" ON "SafetyCourse"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TrainingRequirement_tenantId_roleSheetId_idx" ON "TrainingRequirement"("tenantId", "roleSheetId");

-- CreateIndex
CREATE INDEX "TrainingRequirement_tenantId_machineClassId_idx" ON "TrainingRequirement"("tenantId", "machineClassId");

-- CreateIndex
CREATE INDEX "TrainingRequirement_tenantId_courseId_idx" ON "TrainingRequirement"("tenantId", "courseId");

-- CreateIndex
CREATE INDEX "TrainingSession_tenantId_siteId_status_idx" ON "TrainingSession"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingSession_tenantId_siteId_id_key" ON "TrainingSession"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingSession_tenantId_id_key" ON "TrainingSession"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TrainingAttendance_tenantId_sessionId_idx" ON "TrainingAttendance"("tenantId", "sessionId");

-- CreateIndex
CREATE INDEX "TrainingAttendance_tenantId_employeeId_idx" ON "TrainingAttendance"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttendance_tenantId_key_key" ON "TrainingAttendance"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttendance_tenantId_deviceId_clientEventId_key" ON "TrainingAttendance"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttendance_tenantId_id_key" ON "TrainingAttendance"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TrainingRecord_tenantId_employeeId_courseId_idx" ON "TrainingRecord"("tenantId", "employeeId", "courseId");

-- CreateIndex
CREATE INDEX "TrainingRecord_tenantId_courseId_idx" ON "TrainingRecord"("tenantId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingRecord_tenantId_id_key" ON "TrainingRecord"("tenantId", "id");

-- CreateIndex
CREATE INDEX "InstructionRecord_tenantId_employeeId_idx" ON "InstructionRecord"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "InstructionRecord_tenantId_siteId_instructedOn_idx" ON "InstructionRecord"("tenantId", "siteId", "instructedOn");

-- CreateIndex
CREATE UNIQUE INDEX "PpeItem_tenantId_code_key" ON "PpeItem"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PpeItem_tenantId_companyId_id_key" ON "PpeItem"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PpeItem_tenantId_id_key" ON "PpeItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PpeKitLine_tenantId_ppeItemId_idx" ON "PpeKitLine"("tenantId", "ppeItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PpeKitLine_tenantId_roleSheetId_seq_key" ON "PpeKitLine"("tenantId", "roleSheetId", "seq");

-- CreateIndex
CREATE INDEX "PpeIssue_tenantId_employeeId_idx" ON "PpeIssue"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "PpeIssue_tenantId_siteId_issuedAt_idx" ON "PpeIssue"("tenantId", "siteId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PpeIssue_tenantId_deviceId_clientEventId_key" ON "PpeIssue"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "PpeIssue_tenantId_siteId_id_key" ON "PpeIssue"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "Employee_tenantId_roleSheetId_idx" ON "Employee"("tenantId", "roleSheetId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_siteId_roleSheetId_fkey" FOREIGN KEY ("tenantId", "siteId", "roleSheetId") REFERENCES "RoleSheet"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyAppointment" ADD CONSTRAINT "SafetyAppointment_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyAppointment" ADD CONSTRAINT "SafetyAppointment_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyAppointment" ADD CONSTRAINT "SafetyAppointment_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyAppointment" ADD CONSTRAINT "SafetyAppointment_tenantId_outsidePartyId_fkey" FOREIGN KEY ("tenantId", "outsidePartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyAppointment" ADD CONSTRAINT "SafetyAppointment_tenantId_outsidePartyId_outsideContactId_fkey" FOREIGN KEY ("tenantId", "outsidePartyId", "outsideContactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyAppointment" ADD CONSTRAINT "SafetyAppointment_tenantId_shiftPatternId_fkey" FOREIGN KEY ("tenantId", "shiftPatternId") REFERENCES "ShiftPattern"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RlsNotice" ADD CONSTRAINT "RlsNotice_tenantId_companyId_appointmentId_fkey" FOREIGN KEY ("tenantId", "companyId", "appointmentId") REFERENCES "SafetyAppointment"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyDeadline" ADD CONSTRAINT "SafetyDeadline_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyDeadline" ADD CONSTRAINT "SafetyDeadline_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyDeadline" ADD CONSTRAINT "SafetyDeadline_tenantId_previousId_fkey" FOREIGN KEY ("tenantId", "previousId") REFERENCES "SafetyDeadline"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessmentVersion" ADD CONSTRAINT "RiskAssessmentVersion_tenantId_companyId_siteId_assessment_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "assessmentId") REFERENCES "RiskAssessment"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessmentVersion" ADD CONSTRAINT "RiskAssessmentVersion_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessmentSignature" ADD CONSTRAINT "RiskAssessmentSignature_tenantId_companyId_siteId_versionI_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "versionId") REFERENCES "RiskAssessmentVersion"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessmentSignature" ADD CONSTRAINT "RiskAssessmentSignature_tenantId_companyId_appointmentId_fkey" FOREIGN KEY ("tenantId", "companyId", "appointmentId") REFERENCES "SafetyAppointment"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessmentSignature" ADD CONSTRAINT "RiskAssessmentSignature_tenantId_siteId_signedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "signedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskMeasure" ADD CONSTRAINT "RiskMeasure_tenantId_companyId_siteId_assessmentId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "assessmentId") REFERENCES "RiskAssessment"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskMeasure" ADD CONSTRAINT "RiskMeasure_tenantId_assessmentId_versionId_fkey" FOREIGN KEY ("tenantId", "assessmentId", "versionId") REFERENCES "RiskAssessmentVersion"("tenantId", "assessmentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleSheet" ADD CONSTRAINT "RoleSheet_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleSheetItem" ADD CONSTRAINT "RoleSheetItem_tenantId_siteId_roleSheetId_fkey" FOREIGN KEY ("tenantId", "siteId", "roleSheetId") REFERENCES "RoleSheet"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyCourse" ADD CONSTRAINT "SafetyCourse_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRequirement" ADD CONSTRAINT "TrainingRequirement_tenantId_roleSheetId_fkey" FOREIGN KEY ("tenantId", "roleSheetId") REFERENCES "RoleSheet"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRequirement" ADD CONSTRAINT "TrainingRequirement_tenantId_machineClassId_fkey" FOREIGN KEY ("tenantId", "machineClassId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRequirement" ADD CONSTRAINT "TrainingRequirement_tenantId_courseId_fkey" FOREIGN KEY ("tenantId", "courseId") REFERENCES "SafetyCourse"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_tenantId_courseId_fkey" FOREIGN KEY ("tenantId", "courseId") REFERENCES "SafetyCourse"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_tenantId_companyId_trainerEmployeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "trainerEmployeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_tenantId_providerPartyId_fkey" FOREIGN KEY ("tenantId", "providerPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_tenantId_siteId_sessionId_fkey" FOREIGN KEY ("tenantId", "siteId", "sessionId") REFERENCES "TrainingSession"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_tenantId_siteId_signedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "signedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_tenantId_siteId_countersignedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "countersignedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRecord" ADD CONSTRAINT "TrainingRecord_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRecord" ADD CONSTRAINT "TrainingRecord_tenantId_courseId_fkey" FOREIGN KEY ("tenantId", "courseId") REFERENCES "SafetyCourse"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRecord" ADD CONSTRAINT "TrainingRecord_tenantId_sessionId_fkey" FOREIGN KEY ("tenantId", "sessionId") REFERENCES "TrainingSession"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRecord" ADD CONSTRAINT "TrainingRecord_tenantId_attendanceId_fkey" FOREIGN KEY ("tenantId", "attendanceId") REFERENCES "TrainingAttendance"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrainingRecord" ADD CONSTRAINT "TrainingRecord_tenantId_correctsId_fkey" FOREIGN KEY ("tenantId", "correctsId") REFERENCES "TrainingRecord"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionRecord" ADD CONSTRAINT "InstructionRecord_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionRecord" ADD CONSTRAINT "InstructionRecord_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionRecord" ADD CONSTRAINT "InstructionRecord_tenantId_companyId_instructorEmployeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "instructorEmployeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionRecord" ADD CONSTRAINT "InstructionRecord_tenantId_machineClassId_fkey" FOREIGN KEY ("tenantId", "machineClassId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionRecord" ADD CONSTRAINT "InstructionRecord_tenantId_siteId_machineId_fkey" FOREIGN KEY ("tenantId", "siteId", "machineId") REFERENCES "Machine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionRecord" ADD CONSTRAINT "InstructionRecord_tenantId_siteId_signedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "signedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeItem" ADD CONSTRAINT "PpeItem_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeItem" ADD CONSTRAINT "PpeItem_tenantId_supplierPartyId_fkey" FOREIGN KEY ("tenantId", "supplierPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeKitLine" ADD CONSTRAINT "PpeKitLine_tenantId_siteId_roleSheetId_fkey" FOREIGN KEY ("tenantId", "siteId", "roleSheetId") REFERENCES "RoleSheet"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeKitLine" ADD CONSTRAINT "PpeKitLine_tenantId_ppeItemId_fkey" FOREIGN KEY ("tenantId", "ppeItemId") REFERENCES "PpeItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeIssue" ADD CONSTRAINT "PpeIssue_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeIssue" ADD CONSTRAINT "PpeIssue_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeIssue" ADD CONSTRAINT "PpeIssue_tenantId_companyId_ppeItemId_fkey" FOREIGN KEY ("tenantId", "companyId", "ppeItemId") REFERENCES "PpeItem"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeIssue" ADD CONSTRAINT "PpeIssue_tenantId_siteId_issuedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "issuedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeIssue" ADD CONSTRAINT "PpeIssue_tenantId_siteId_signedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "signedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeIssue" ADD CONSTRAINT "PpeIssue_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeIssue" ADD CONSTRAINT "PpeIssue_tenantId_siteId_voidsId_fkey" FOREIGN KEY ("tenantId", "siteId", "voidsId") REFERENCES "PpeIssue"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

