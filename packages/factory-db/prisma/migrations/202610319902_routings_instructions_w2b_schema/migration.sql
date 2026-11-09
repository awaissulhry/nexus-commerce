-- CreateEnum
CREATE TYPE "OperationTimeSource" AS ENUM ('TIME_STUDY', 'PREDETERMINED', 'ESTIMATE');

-- CreateEnum
CREATE TYPE "OperationTimeVersionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "InstructionVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "InstructionMediaKind" AS ENUM ('PHOTO', 'VIDEO');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'WORK_INSTRUCTION';

-- AlterTable
ALTER TABLE "Operation" ADD COLUMN     "basicMinutes" DECIMAL(10,3),
ADD COLUMN     "delayPct" DECIMAL(7,4),
ADD COLUMN     "fatiguePct" DECIMAL(7,4),
ADD COLUMN     "personalPct" DECIMAL(7,4);

-- AlterTable
ALTER TABLE "RoutingOperation" ADD COLUMN     "appliesToColourwayIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "appliesToOptionValueIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "appliesToSizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "basicMinutes" DECIMAL(10,3),
ADD COLUMN     "delayPct" DECIMAL(7,4),
ADD COLUMN     "fatiguePct" DECIMAL(7,4),
ADD COLUMN     "inspectionPlanId" UUID,
ADD COLUMN     "moveMinutes" DECIMAL(10,3),
ADD COLUMN     "personalPct" DECIMAL(7,4),
ADD COLUMN     "setupMinutes" DECIMAL(10,3),
ADD COLUMN     "timeVersionId" UUID,
ADD COLUMN     "waitMinutes" DECIMAL(10,3);

-- AlterTable
ALTER TABLE "StyleRevision" ADD COLUMN     "effectiveFrom" DATE,
ADD COLUMN     "effectiveTo" DATE;

-- CreateTable
CREATE TABLE "OperationTimeVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "operationId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "OperationTimeVersionStatus" NOT NULL DEFAULT 'PROPOSED',
    "basicMinutes" DECIMAL(10,3) NOT NULL,
    "personalPct" DECIMAL(7,4) NOT NULL,
    "fatiguePct" DECIMAL(7,4) NOT NULL,
    "delayPct" DECIMAL(7,4) NOT NULL,
    "standardMinutes" DECIMAL(10,3) NOT NULL,
    "source" "OperationTimeSource" NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "proposedById" UUID NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OperationTimeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingOperationSizeTime" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "revisionId" UUID NOT NULL,
    "routingOperationId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "extraMinutes" DECIMAL(10,3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RoutingOperationSizeTime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationMachineSetting" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "operationId" UUID,
    "revisionId" UUID,
    "routingOperationId" UUID,
    "seq" INTEGER NOT NULL,
    "machineClassId" UUID,
    "stitchType" TEXT,
    "needle" TEXT,
    "thread" TEXT,
    "stitchesPerCm" DECIMAL(6,2),
    "tension" TEXT,
    "foot" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OperationMachineSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkInstruction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "operationId" UUID NOT NULL,
    "styleId" UUID,
    "styleRevisionId" UUID,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkInstructionVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "instructionId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "InstructionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "changeNote" TEXT,
    "authorId" UUID NOT NULL,
    "approvedById" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT true,
    "supersededAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkInstructionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkInstructionStep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID NOT NULL,
    "versionStatus" "InstructionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "textI18n" JSONB NOT NULL,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "safetyNoteI18n" JSONB,
    "icon" TEXT,
    "requiredTick" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkInstructionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkInstructionMedia" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID NOT NULL,
    "versionStatus" "InstructionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "stepId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "kind" "InstructionMediaKind" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "captionI18n" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkInstructionMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstructionAcknowledgement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "employeeId" UUID,
    "locale" TEXT NOT NULL,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "deviceTime" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InstructionAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationTimeVersion_tenantId_status_idx" ON "OperationTimeVersion"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OperationTimeVersion_tenantId_operationId_number_key" ON "OperationTimeVersion"("tenantId", "operationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "OperationTimeVersion_tenantId_operationId_id_key" ON "OperationTimeVersion"("tenantId", "operationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingOperationSizeTime_tenantId_routingOperationId_size_key" ON "RoutingOperationSizeTime"("tenantId", "routingOperationId", "size");

-- CreateIndex
CREATE UNIQUE INDEX "OperationMachineSetting_tenantId_operationId_seq_key" ON "OperationMachineSetting"("tenantId", "operationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "OperationMachineSetting_tenantId_routingOperationId_seq_key" ON "OperationMachineSetting"("tenantId", "routingOperationId", "seq");

-- CreateIndex
CREATE INDEX "WorkInstruction_tenantId_operationId_idx" ON "WorkInstruction"("tenantId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkInstruction_tenantId_companyId_number_key" ON "WorkInstruction"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "WorkInstruction_tenantId_id_key" ON "WorkInstruction"("tenantId", "id");

-- CreateIndex
CREATE INDEX "WorkInstructionVersion_tenantId_instructionId_status_idx" ON "WorkInstructionVersion"("tenantId", "instructionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkInstructionVersion_tenantId_instructionId_number_key" ON "WorkInstructionVersion"("tenantId", "instructionId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "WorkInstructionVersion_tenantId_id_key" ON "WorkInstructionVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkInstructionVersion_tenantId_id_status_key" ON "WorkInstructionVersion"("tenantId", "id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkInstructionStep_tenantId_versionId_code_key" ON "WorkInstructionStep"("tenantId", "versionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "WorkInstructionStep_tenantId_versionId_id_key" ON "WorkInstructionStep"("tenantId", "versionId", "id");

-- CreateIndex
CREATE INDEX "WorkInstructionMedia_tenantId_stepId_idx" ON "WorkInstructionMedia"("tenantId", "stepId");

-- CreateIndex
CREATE INDEX "InstructionAcknowledgement_tenantId_versionId_workerId_idx" ON "InstructionAcknowledgement"("tenantId", "versionId", "workerId");

-- CreateIndex
CREATE INDEX "InstructionAcknowledgement_tenantId_employeeId_idx" ON "InstructionAcknowledgement"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "InstructionAcknowledgement_tenantId_deviceId_clientEventId_key" ON "InstructionAcknowledgement"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlan_tenantId_id_key" ON "InspectionPlan"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingOperation_tenantId_revisionId_id_key" ON "RoutingOperation"("tenantId", "revisionId", "id");

-- AddForeignKey
ALTER TABLE "OperationTimeVersion" ADD CONSTRAINT "OperationTimeVersion_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingOperationSizeTime" ADD CONSTRAINT "RoutingOperationSizeTime_tenantId_revisionId_routingOperat_fkey" FOREIGN KEY ("tenantId", "revisionId", "routingOperationId") REFERENCES "RoutingOperation"("tenantId", "revisionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationMachineSetting" ADD CONSTRAINT "OperationMachineSetting_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationMachineSetting" ADD CONSTRAINT "OperationMachineSetting_tenantId_revisionId_routingOperati_fkey" FOREIGN KEY ("tenantId", "revisionId", "routingOperationId") REFERENCES "RoutingOperation"("tenantId", "revisionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationMachineSetting" ADD CONSTRAINT "OperationMachineSetting_tenantId_machineClassId_fkey" FOREIGN KEY ("tenantId", "machineClassId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkInstruction" ADD CONSTRAINT "WorkInstruction_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkInstruction" ADD CONSTRAINT "WorkInstruction_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkInstruction" ADD CONSTRAINT "WorkInstruction_tenantId_styleId_styleRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "styleRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkInstructionVersion" ADD CONSTRAINT "WorkInstructionVersion_tenantId_instructionId_fkey" FOREIGN KEY ("tenantId", "instructionId") REFERENCES "WorkInstruction"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkInstructionStep" ADD CONSTRAINT "WorkInstructionStep_tenantId_versionId_versionStatus_fkey" FOREIGN KEY ("tenantId", "versionId", "versionStatus") REFERENCES "WorkInstructionVersion"("tenantId", "id", "status") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkInstructionMedia" ADD CONSTRAINT "WorkInstructionMedia_tenantId_versionId_stepId_fkey" FOREIGN KEY ("tenantId", "versionId", "stepId") REFERENCES "WorkInstructionStep"("tenantId", "versionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkInstructionMedia" ADD CONSTRAINT "WorkInstructionMedia_tenantId_versionId_versionStatus_fkey" FOREIGN KEY ("tenantId", "versionId", "versionStatus") REFERENCES "WorkInstructionVersion"("tenantId", "id", "status") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkInstructionMedia" ADD CONSTRAINT "WorkInstructionMedia_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionAcknowledgement" ADD CONSTRAINT "InstructionAcknowledgement_tenantId_versionId_fkey" FOREIGN KEY ("tenantId", "versionId") REFERENCES "WorkInstructionVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionAcknowledgement" ADD CONSTRAINT "InstructionAcknowledgement_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionAcknowledgement" ADD CONSTRAINT "InstructionAcknowledgement_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InstructionAcknowledgement" ADD CONSTRAINT "InstructionAcknowledgement_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_tenantId_operationId_timeVersionId_fkey" FOREIGN KEY ("tenantId", "operationId", "timeVersionId") REFERENCES "OperationTimeVersion"("tenantId", "operationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_tenantId_inspectionPlanId_fkey" FOREIGN KEY ("tenantId", "inspectionPlanId") REFERENCES "InspectionPlan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

