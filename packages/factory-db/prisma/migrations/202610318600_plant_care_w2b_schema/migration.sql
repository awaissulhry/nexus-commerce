-- CreateEnum
CREATE TYPE "CheckIntervalUnit" AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "CheckPlanStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "CheckOutcome" AS ENUM ('PASSED', 'PASSED_WITH_REMARKS', 'FAILED');

-- CreateEnum
CREATE TYPE "DieCondition" AS ENUM ('GOOD', 'WORN', 'DAMAGED', 'RETIRED');

-- CreateEnum
CREATE TYPE "PlantLockBy" AS ENUM ('ANYONE_AT_STATION', 'LEADS_AND_TECHNICIANS');

-- CreateEnum
CREATE TYPE "PlantSignSafeBy" AS ENUM ('TECHNICIANS', 'TECHNICIANS_AND_SAFETY_OFFICER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileCategory" ADD VALUE 'MACHINE_CE';
ALTER TYPE "FileCategory" ADD VALUE 'MANUAL';
ALTER TYPE "FileCategory" ADD VALUE 'CHECK_REPORT';
ALTER TYPE "FileCategory" ADD VALUE 'BEFORE_WORK';
ALTER TYPE "FileCategory" ADD VALUE 'AFTER_WORK';

-- AlterEnum
ALTER TYPE "FileKind" ADD VALUE 'AUDIO';

-- AlterTable
ALTER TABLE "MachineClass" ADD COLUMN     "authorisationRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MaintenanceJob" ADD COLUMN     "checkResultId" UUID,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "leadConfirmedAt" TIMESTAMPTZ(3),
ADD COLUMN     "leadConfirmedById" UUID,
ADD COLUMN     "leadConfirmedByWorkerId" UUID,
ADD COLUMN     "minutesSpent" INTEGER;

-- AlterTable
ALTER TABLE "MaintenanceRequest" ADD COLUMN     "acknowledgedByWorkerId" UUID,
ADD COLUMN     "confirmedWorksAt" TIMESTAMPTZ(3),
ADD COLUMN     "confirmedWorksById" UUID,
ADD COLUMN     "confirmedWorksByWorkerId" UUID,
ADD COLUMN     "escalatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "escalationLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onTheWayAt" TIMESTAMPTZ(3),
ADD COLUMN     "onTheWayById" UUID,
ADD COLUMN     "onTheWayByWorkerId" UUID,
ADD COLUMN     "routedEmployeeId" UUID,
ADD COLUMN     "routedTeamId" UUID,
ADD COLUMN     "routingRuleId" UUID;

-- AlterTable
ALTER TABLE "StoredFile" ALTER COLUMN "legalHold" SET DEFAULT ('false'::text)::boolean;

-- CreateTable
CREATE TABLE "MachineCheckType" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "legalBasis" TEXT NOT NULL,
    "classId" UUID,
    "defaultInterval" INTEGER NOT NULL,
    "defaultIntervalUnit" "CheckIntervalUnit" NOT NULL,
    "outsideBody" BOOLEAN NOT NULL DEFAULT false,
    "retentionYears" INTEGER NOT NULL DEFAULT 3,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MachineCheckType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineCheckPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "checkTypeId" UUID NOT NULL,
    "interval" INTEGER NOT NULL,
    "intervalUnit" "CheckIntervalUnit" NOT NULL,
    "outsideBodyPartyId" UUID,
    "ownerId" UUID,
    "firstDueOn" DATE NOT NULL,
    "nextDueOn" DATE NOT NULL,
    "reminderDays" INTEGER NOT NULL DEFAULT 30,
    "lastRemindedAt" TIMESTAMPTZ(3),
    "status" "CheckPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "endedAt" TIMESTAMPTZ(3),
    "endedReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MachineCheckPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineCheckResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "checkTypeId" UUID NOT NULL,
    "planId" UUID,
    "performedOn" DATE NOT NULL,
    "outcome" "CheckOutcome" NOT NULL,
    "remarks" TEXT,
    "performedBy" TEXT NOT NULL,
    "outsideBodyPartyId" UUID,
    "nextDueOn" DATE,
    "keptUntil" DATE NOT NULL,
    "correctsId" UUID,
    "correctionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MachineCheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineStatusEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "fromStatus" "MachineStatus",
    "toStatus" "MachineStatus" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachineStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClickingDie" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "styleId" UUID NOT NULL,
    "size" TEXT,
    "piece" TEXT NOT NULL,
    "patternPieceId" UUID,
    "rackLocation" TEXT,
    "material" TEXT,
    "supplierId" UUID,
    "purchaseCost" INTEGER,
    "condition" "DieCondition" NOT NULL DEFAULT 'GOOD',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ClickingDie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlantSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "lockBy" "PlantLockBy" NOT NULL DEFAULT 'ANYONE_AT_STATION',
    "signSafeBy" "PlantSignSafeBy" NOT NULL DEFAULT 'TECHNICIANS',
    "hazardReportOnLock" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PlantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestRoutingRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "machineClassId" UUID,
    "teamId" UUID,
    "technicianId" UUID,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "escalateAfterMinutes" INTEGER,
    "escalateToId" UUID,
    "escalateAgainAfterMinutes" INTEGER,
    "escalateAgainToId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RequestRoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MachineCheckType_tenantId_code_key" ON "MachineCheckType"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "MachineCheckType_tenantId_id_key" ON "MachineCheckType"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MachineCheckPlan_tenantId_machineId_idx" ON "MachineCheckPlan"("tenantId", "machineId");

-- CreateIndex
CREATE INDEX "MachineCheckPlan_tenantId_nextDueOn_idx" ON "MachineCheckPlan"("tenantId", "nextDueOn");

-- CreateIndex
CREATE UNIQUE INDEX "MachineCheckPlan_tenantId_siteId_id_key" ON "MachineCheckPlan"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "MachineCheckResult_tenantId_machineId_performedOn_idx" ON "MachineCheckResult"("tenantId", "machineId", "performedOn");

-- CreateIndex
CREATE INDEX "MachineCheckResult_tenantId_planId_idx" ON "MachineCheckResult"("tenantId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "MachineCheckResult_tenantId_siteId_id_key" ON "MachineCheckResult"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "MachineStatusEvent_tenantId_machineId_at_idx" ON "MachineStatusEvent"("tenantId", "machineId", "at");

-- CreateIndex
CREATE INDEX "ClickingDie_tenantId_siteId_idx" ON "ClickingDie"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "ClickingDie_tenantId_styleId_idx" ON "ClickingDie"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "ClickingDie_tenantId_code_key" ON "ClickingDie"("tenantId", "code");

-- CreateIndex
CREATE INDEX "PlantSettings_tenantId_siteId_idx" ON "PlantSettings"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "RequestRoutingRule_tenantId_siteId_seq_idx" ON "RequestRoutingRule"("tenantId", "siteId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "RequestRoutingRule_tenantId_siteId_id_key" ON "RequestRoutingRule"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PatternPiece_tenantId_styleId_id_key" ON "PatternPiece"("tenantId", "styleId", "id");

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_acknowledgedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "acknowledgedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_onTheWayByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "onTheWayByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_confirmedWorksByWorkerI_fkey" FOREIGN KEY ("tenantId", "siteId", "confirmedWorksByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_routingRuleId_fkey" FOREIGN KEY ("tenantId", "siteId", "routingRuleId") REFERENCES "RequestRoutingRule"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_routedTeamId_fkey" FOREIGN KEY ("tenantId", "siteId", "routedTeamId") REFERENCES "Team"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_companyId_routedEmployeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "routedEmployeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_tenantId_siteId_leadConfirmedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "leadConfirmedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_tenantId_siteId_checkResultId_fkey" FOREIGN KEY ("tenantId", "siteId", "checkResultId") REFERENCES "MachineCheckResult"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckType" ADD CONSTRAINT "MachineCheckType_tenantId_classId_fkey" FOREIGN KEY ("tenantId", "classId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckPlan" ADD CONSTRAINT "MachineCheckPlan_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckPlan" ADD CONSTRAINT "MachineCheckPlan_tenantId_siteId_machineId_fkey" FOREIGN KEY ("tenantId", "siteId", "machineId") REFERENCES "Machine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckPlan" ADD CONSTRAINT "MachineCheckPlan_tenantId_checkTypeId_fkey" FOREIGN KEY ("tenantId", "checkTypeId") REFERENCES "MachineCheckType"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckPlan" ADD CONSTRAINT "MachineCheckPlan_tenantId_outsideBodyPartyId_fkey" FOREIGN KEY ("tenantId", "outsideBodyPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckResult" ADD CONSTRAINT "MachineCheckResult_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckResult" ADD CONSTRAINT "MachineCheckResult_tenantId_siteId_machineId_fkey" FOREIGN KEY ("tenantId", "siteId", "machineId") REFERENCES "Machine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckResult" ADD CONSTRAINT "MachineCheckResult_tenantId_checkTypeId_fkey" FOREIGN KEY ("tenantId", "checkTypeId") REFERENCES "MachineCheckType"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckResult" ADD CONSTRAINT "MachineCheckResult_tenantId_siteId_planId_fkey" FOREIGN KEY ("tenantId", "siteId", "planId") REFERENCES "MachineCheckPlan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckResult" ADD CONSTRAINT "MachineCheckResult_tenantId_outsideBodyPartyId_fkey" FOREIGN KEY ("tenantId", "outsideBodyPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineCheckResult" ADD CONSTRAINT "MachineCheckResult_tenantId_siteId_correctsId_fkey" FOREIGN KEY ("tenantId", "siteId", "correctsId") REFERENCES "MachineCheckResult"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineStatusEvent" ADD CONSTRAINT "MachineStatusEvent_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineStatusEvent" ADD CONSTRAINT "MachineStatusEvent_tenantId_siteId_machineId_fkey" FOREIGN KEY ("tenantId", "siteId", "machineId") REFERENCES "Machine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClickingDie" ADD CONSTRAINT "ClickingDie_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClickingDie" ADD CONSTRAINT "ClickingDie_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClickingDie" ADD CONSTRAINT "ClickingDie_tenantId_styleId_patternPieceId_fkey" FOREIGN KEY ("tenantId", "styleId", "patternPieceId") REFERENCES "PatternPiece"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClickingDie" ADD CONSTRAINT "ClickingDie_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlantSettings" ADD CONSTRAINT "PlantSettings_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestRoutingRule" ADD CONSTRAINT "RequestRoutingRule_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestRoutingRule" ADD CONSTRAINT "RequestRoutingRule_tenantId_machineClassId_fkey" FOREIGN KEY ("tenantId", "machineClassId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestRoutingRule" ADD CONSTRAINT "RequestRoutingRule_tenantId_siteId_teamId_fkey" FOREIGN KEY ("tenantId", "siteId", "teamId") REFERENCES "Team"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestRoutingRule" ADD CONSTRAINT "RequestRoutingRule_tenantId_companyId_technicianId_fkey" FOREIGN KEY ("tenantId", "companyId", "technicianId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestRoutingRule" ADD CONSTRAINT "RequestRoutingRule_tenantId_companyId_escalateToId_fkey" FOREIGN KEY ("tenantId", "companyId", "escalateToId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestRoutingRule" ADD CONSTRAINT "RequestRoutingRule_tenantId_companyId_escalateAgainToId_fkey" FOREIGN KEY ("tenantId", "companyId", "escalateAgainToId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

