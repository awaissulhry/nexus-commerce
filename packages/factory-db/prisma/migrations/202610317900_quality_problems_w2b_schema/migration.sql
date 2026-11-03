-- CreateEnum
CREATE TYPE "CapaType" AS ENUM ('CAPA', 'EIGHT_D');

-- CreateEnum
CREATE TYPE "CapaPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "CapaStatus" AS ENUM ('PLAN', 'ACT', 'CHECK', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CapaActionKind" AS ENUM ('CORRECTIVE', 'PREVENTIVE');

-- CreateEnum
CREATE TYPE "CapaActionStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ComplaintAnswerChannel" AS ENUM ('EMAIL', 'PORTAL');

-- CreateEnum
CREATE TYPE "CauseProcess" AS ENUM ('MATERIAL', 'SUPPLIER', 'CUTTING', 'SEWING', 'FINISHING', 'HANDLING', 'DESIGN', 'MEASUREMENT');

-- CreateEnum
CREATE TYPE "HoldNextStep" AS ENUM ('NEW', 'INVESTIGATING', 'WAITING_DECISION', 'READY_TO_RELEASE');

-- CreateEnum
CREATE TYPE "NcrCostKind" AS ENUM ('MATERIAL', 'LABOUR', 'REWORK_TIME', 'SCRAP_VALUE', 'FREIGHT', 'OTHER');

-- CreateEnum
CREATE TYPE "NcrCostSource" AS ENUM ('TYPED', 'COMPUTED');

-- CreateEnum
CREATE TYPE "NcrConcessionStatus" AS ENUM ('ASKED', 'ACCEPTED', 'REFUSED');

-- CreateEnum
CREATE TYPE "QualityAlertEvent" AS ENUM ('HOLD_PLACED', 'CRITICAL_NCR', 'SAFETY_COMPLAINT', 'INSPECTION_WAITING', 'CERTIFICATE_EXPIRING', 'RELEASE_WAITING_SECOND_PERSON', 'CAPA_ACTION_OVERDUE');

-- CreateEnum
CREATE TYPE "QualityAlertAudience" AS ENUM ('OWNER', 'ROLE', 'OWNER_AND_ROLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'INSPECTION_REPORT';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'CERTIFICATE_OF_CONFORMITY';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'NCR_REPORT';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'EIGHT_D';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'COMPLAINT_ANSWER';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'CHECK_REPORT';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'DVR_FROZEN';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'PPE_RECEIPT';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'CAPA';

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "answerDocumentId" UUID,
ADD COLUMN     "answerFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "answerLanguage" TEXT,
ADD COLUMN     "answerTemplate" TEXT,
ADD COLUMN     "answerText" TEXT,
ADD COLUMN     "answeredById" UUID,
ADD COLUMN     "answeredVia" "ComplaintAnswerChannel",
ADD COLUMN     "findings" TEXT,
ADD COLUMN     "rootCause" TEXT;

-- AlterTable
ALTER TABLE "GeneratedDocument" ALTER COLUMN "siteId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InspectionDefect" ADD COLUMN     "causeCodeId" UUID;

-- AlterTable
ALTER TABLE "Nonconformance" ADD COLUMN     "capaId" UUID,
ADD COLUMN     "causeCodeId" UUID;

-- AlterTable
ALTER TABLE "OperationScanDefect" ADD COLUMN     "causedAtOperationId" UUID;

-- AlterTable
ALTER TABLE "QualityHold" ADD COLUMN     "groupId" UUID,
ADD COLUMN     "nextStep" "HoldNextStep" NOT NULL DEFAULT ('NEW'::text)::"HoldNextStep";

-- AlterTable
ALTER TABLE "QualitySettings" ADD COLUMN     "benchUndoSeconds" INTEGER,
ADD COLUMN     "fourEyesConditions" "ReleaseSecondPersonReason"[] DEFAULT ARRAY['OVERRIDE', 'CUSTOMER']::"ReleaseSecondPersonReason"[],
ADD COLUMN     "stopAtRejectNumber" BOOLEAN;

-- CreateTable
CREATE TABLE "Capa" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "CapaType" NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "team" JSONB NOT NULL DEFAULT '[]',
    "dueOn" DATE NOT NULL,
    "priority" "CapaPriority" NOT NULL DEFAULT 'NORMAL',
    "customerId" UUID,
    "problemWhat" TEXT,
    "problemWhere" TEXT,
    "problemWhen" TEXT,
    "problemHowMany" TEXT,
    "status" "CapaStatus" NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Capa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapaSource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "capaId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CapaSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapaAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "capaId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "CapaActionKind" NOT NULL,
    "description" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "dueOn" DATE NOT NULL,
    "status" "CapaActionStatus" NOT NULL DEFAULT 'OPEN',
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMPTZ(3),
    "escalateToId" UUID,
    "escalatedAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "evidenceNote" TEXT,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CapaAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CauseCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "process" "CauseProcess" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CauseCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityHoldGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonNote" TEXT,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "placedAt" TIMESTAMPTZ(3) NOT NULL,
    "placedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QualityHoldGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NcrCostLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "ncrId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "NcrCostKind" NOT NULL,
    "source" "NcrCostSource" NOT NULL DEFAULT 'TYPED',
    "description" TEXT,
    "amount" INTEGER NOT NULL,
    "recordType" TEXT,
    "recordId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "NcrCostLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NcrConcession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "ncrId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "ask" TEXT NOT NULL,
    "proposal" TEXT NOT NULL,
    "status" "NcrConcessionStatus" NOT NULL DEFAULT 'ASKED',
    "askedAt" TIMESTAMPTZ(3) NOT NULL,
    "askedById" UUID,
    "answer" TEXT,
    "answeredAt" TIMESTAMPTZ(3),
    "answeredBy" TEXT,
    "answerFileId" UUID,
    "recordedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "NcrConcession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityAlertRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "event" "QualityAlertEvent" NOT NULL,
    "audience" "QualityAlertAudience" NOT NULL,
    "roleId" UUID,
    "withinMinutes" INTEGER NOT NULL DEFAULT 0,
    "daysBefore" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "channels" "AlertChannel"[] DEFAULT ARRAY['IN_APP']::"AlertChannel"[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QualityAlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Capa_tenantId_status_dueOn_idx" ON "Capa"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "Capa_tenantId_customerId_idx" ON "Capa"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Capa_tenantId_companyId_number_key" ON "Capa"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Capa_tenantId_companyId_id_key" ON "Capa"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Capa_tenantId_id_key" ON "Capa"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CapaSource_tenantId_capaId_idx" ON "CapaSource"("tenantId", "capaId");

-- CreateIndex
CREATE INDEX "CapaSource_tenantId_recordType_recordId_idx" ON "CapaSource"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "CapaAction_tenantId_status_dueOn_idx" ON "CapaAction"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "CapaAction_tenantId_capaId_seq_key" ON "CapaAction"("tenantId", "capaId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "CauseCode_tenantId_code_key" ON "CauseCode"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CauseCode_tenantId_id_key" ON "CauseCode"("tenantId", "id");

-- CreateIndex
CREATE INDEX "QualityHoldGroup_tenantId_sourceType_sourceId_idx" ON "QualityHoldGroup"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "QualityHoldGroup_tenantId_companyId_id_key" ON "QualityHoldGroup"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NcrCostLine_tenantId_ncrId_seq_key" ON "NcrCostLine"("tenantId", "ncrId", "seq");

-- CreateIndex
CREATE INDEX "NcrConcession_tenantId_partyId_idx" ON "NcrConcession"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "NcrConcession_tenantId_ncrId_seq_key" ON "NcrConcession"("tenantId", "ncrId", "seq");

-- CreateIndex
CREATE INDEX "QualityAlertRule_tenantId_event_idx" ON "QualityAlertRule"("tenantId", "event");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocument_tenantId_id_key" ON "GeneratedDocument"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Nonconformance_tenantId_capaId_idx" ON "Nonconformance"("tenantId", "capaId");

-- CreateIndex
CREATE INDEX "OperationScanDefect_tenantId_causedAtOperationId_idx" ON "OperationScanDefect"("tenantId", "causedAtOperationId");

-- CreateIndex
CREATE INDEX "QualityHold_tenantId_groupId_idx" ON "QualityHold"("tenantId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderOperation_tenantId_siteId_id_key" ON "WorkOrderOperation"("tenantId", "siteId", "id");

-- AddForeignKey
ALTER TABLE "Capa" ADD CONSTRAINT "Capa_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Capa" ADD CONSTRAINT "Capa_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CapaSource" ADD CONSTRAINT "CapaSource_tenantId_capaId_fkey" FOREIGN KEY ("tenantId", "capaId") REFERENCES "Capa"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CapaAction" ADD CONSTRAINT "CapaAction_tenantId_capaId_fkey" FOREIGN KEY ("tenantId", "capaId") REFERENCES "Capa"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_answerDocumentId_fkey" FOREIGN KEY ("tenantId", "answerDocumentId") REFERENCES "GeneratedDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityHold" ADD CONSTRAINT "QualityHold_tenantId_companyId_groupId_fkey" FOREIGN KEY ("tenantId", "companyId", "groupId") REFERENCES "QualityHoldGroup"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityHoldGroup" ADD CONSTRAINT "QualityHoldGroup_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_causeCodeId_fkey" FOREIGN KEY ("tenantId", "causeCodeId") REFERENCES "CauseCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_companyId_capaId_fkey" FOREIGN KEY ("tenantId", "companyId", "capaId") REFERENCES "Capa"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrCostLine" ADD CONSTRAINT "NcrCostLine_tenantId_siteId_ncrId_fkey" FOREIGN KEY ("tenantId", "siteId", "ncrId") REFERENCES "Nonconformance"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrConcession" ADD CONSTRAINT "NcrConcession_tenantId_siteId_ncrId_fkey" FOREIGN KEY ("tenantId", "siteId", "ncrId") REFERENCES "Nonconformance"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrConcession" ADD CONSTRAINT "NcrConcession_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrConcession" ADD CONSTRAINT "NcrConcession_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrConcession" ADD CONSTRAINT "NcrConcession_tenantId_answerFileId_fkey" FOREIGN KEY ("tenantId", "answerFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScanDefect" ADD CONSTRAINT "OperationScanDefect_tenantId_siteId_causedAtOperationId_fkey" FOREIGN KEY ("tenantId", "siteId", "causedAtOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionDefect" ADD CONSTRAINT "InspectionDefect_tenantId_causeCodeId_fkey" FOREIGN KEY ("tenantId", "causeCodeId") REFERENCES "CauseCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityAlertRule" ADD CONSTRAINT "QualityAlertRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityAlertRule" ADD CONSTRAINT "QualityAlertRule_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

