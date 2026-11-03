-- CreateEnum
CREATE TYPE "HealthVisitType" AS ENUM ('PREVENTIVE', 'PERIODIC', 'ON_REQUEST', 'CHANGE_OF_TASK', 'RETURN_AFTER_ABSENCE', 'END_OF_EMPLOYMENT');

-- CreateEnum
CREATE TYPE "HealthVisitStatus" AS ENUM ('DUE', 'BOOKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HealthVisitCancelReason" AS ENUM ('NOT_NEEDED', 'LEFT', 'REPLACED', 'MISTAKE');

-- CreateEnum
CREATE TYPE "FitnessOutcome" AS ENUM ('FIT', 'FIT_WITH_LIMITS', 'TEMPORARILY_UNFIT', 'UNFIT');

-- CreateEnum
CREATE TYPE "FitnessJudgementVoidReason" AS ENUM ('WRONG_PERSON', 'WRONG_DETAILS', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "ProtectedRecordType" AS ENUM ('HEALTH_VISIT', 'FITNESS_JUDGEMENT', 'INCIDENT_PERSON', 'INAIL_FILING', 'INCIDENT_PEOPLE_LIST', 'HEALTH_VISIT_LIST');

-- CreateEnum
CREATE TYPE "ProtectedViewWhat" AS ENUM ('OPEN', 'LIST', 'COPY', 'PRINT');

-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('INJURY', 'NEAR_MISS', 'HAZARD');

-- CreateEnum
CREATE TYPE "IncidentReportedVia" AS ENUM ('FLOOR', 'OFFICE');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('NONE', 'FIRST_AID', 'LOST_DAYS');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncidentInvolvement" AS ENUM ('INJURED', 'INVOLVED');

-- CreateEnum
CREATE TYPE "IncidentBodyPart" AS ENUM ('HEAD', 'EYE', 'FACE', 'NECK', 'SHOULDER', 'ARM', 'ELBOW', 'WRIST', 'HAND', 'FINGER', 'BACK', 'CHEST', 'ABDOMEN', 'HIP', 'LEG', 'KNEE', 'ANKLE', 'FOOT', 'TOE', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "IncidentBodySide" AS ENUM ('LEFT', 'RIGHT', 'BOTH');

-- CreateEnum
CREATE TYPE "IncidentInjuryNature" AS ENUM ('CUT', 'PUNCTURE', 'CRUSH', 'BRUISE', 'BURN', 'CHEMICAL_BURN', 'FRACTURE', 'SPRAIN', 'STRAIN', 'FOREIGN_BODY', 'ELECTRIC_SHOCK', 'AMPUTATION', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentActionStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncidentActionLink" AS ENUM ('MAINTENANCE_JOB', 'RISK_MEASURE', 'TRAINING_SESSION');

-- CreateEnum
CREATE TYPE "InailFilingType" AS ENUM ('STATISTICAL', 'INSURANCE');

-- CreateEnum
CREATE TYPE "InailFilingStatus" AS ENUM ('WAITING_CERTIFICATE', 'DUE', 'FILED', 'NOT_NEEDED');

-- CreateEnum
CREATE TYPE "ChemicalUse" AS ENUM ('GLUE', 'SOLVENT', 'PRIMER', 'FINISH', 'EDGE_PAINT', 'DYE', 'CLEANER', 'OIL', 'OTHER');

-- CreateEnum
CREATE TYPE "GhsPictogram" AS ENUM ('GHS01', 'GHS02', 'GHS03', 'GHS04', 'GHS05', 'GHS06', 'GHS07', 'GHS08', 'GHS09');

-- CreateEnum
CREATE TYPE "ChemicalSignalWord" AS ENUM ('DANGER', 'WARNING');

-- CreateEnum
CREATE TYPE "ChemicalQuantityUnit" AS ENUM ('ML', 'L', 'G', 'KG');

-- CreateEnum
CREATE TYPE "SafetyDataSheetStatus" AS ENUM ('CURRENT', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'INCIDENT';

-- CreateTable
CREATE TABLE "HealthPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "roleSheetId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "needed" BOOLEAN NOT NULL,
    "frequencyMonths" INTEGER,
    "endOfEmploymentVisit" BOOLEAN NOT NULL DEFAULT false,
    "setOn" DATE NOT NULL,
    "doctorAppointmentId" UUID,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HealthPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthVisit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "type" "HealthVisitType" NOT NULL,
    "dueOn" DATE NOT NULL,
    "planId" UUID,
    "roleSheetId" UUID,
    "absenceDays" INTEGER,
    "status" "HealthVisitStatus" NOT NULL DEFAULT 'DUE',
    "bookedOn" DATE,
    "bookedPlace" TEXT,
    "bookedAt" TIMESTAMPTZ(3),
    "bookedById" UUID,
    "doneOn" DATE,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" "HealthVisitCancelReason",
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HealthVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessJudgement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "visitId" UUID,
    "outcome" "FitnessOutcome" NOT NULL,
    "taskLimits" TEXT,
    "unfitUntil" DATE,
    "judgedOn" DATE NOT NULL,
    "expiresOn" DATE,
    "doctorAppointmentId" UUID,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" "FitnessJudgementVoidReason",
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FitnessJudgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectedView" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "recordType" "ProtectedRecordType" NOT NULL,
    "recordId" UUID,
    "employeeId" UUID,
    "what" "ProtectedViewWhat" NOT NULL,
    "viewerId" UUID NOT NULL,
    "viewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtectedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "IncidentKind" NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "what" TEXT NOT NULL,
    "areaId" UUID,
    "stationId" UUID,
    "machineId" UUID,
    "place" TEXT,
    "immediateAction" TEXT,
    "maintenanceRequestId" UUID,
    "severity" "IncidentSeverity",
    "reportedVia" "IncidentReportedVia" NOT NULL,
    "reporterAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "reportedByWorkerId" UUID,
    "reportedById" UUID,
    "deviceId" UUID,
    "seenAt" TIMESTAMPTZ(3),
    "seenById" UUID,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentPerson" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "involvement" "IncidentInvolvement" NOT NULL,
    "employeeId" UUID,
    "outsideName" TEXT,
    "bodyParts" "IncidentBodyPart"[] DEFAULT ARRAY[]::"IncidentBodyPart"[],
    "bodySide" "IncidentBodySide",
    "nature" "IncidentInjuryNature",
    "firstAidGiven" BOOLEAN NOT NULL DEFAULT false,
    "sentToHospital" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IncidentPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" UUID,
    "dueOn" DATE,
    "status" "IncidentActionStatus" NOT NULL DEFAULT 'OPEN',
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "evidenceNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "madeInto" "IncidentActionLink",
    "maintenanceJobId" UUID,
    "riskMeasureId" UUID,
    "trainingSessionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IncidentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InailFiling" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "incidentPersonId" UUID NOT NULL,
    "type" "InailFilingType" NOT NULL,
    "key" TEXT NOT NULL,
    "expectedAbsenceDays" INTEGER,
    "actualAbsenceDays" INTEGER,
    "certificateReference" TEXT,
    "certificateReceivedAt" TIMESTAMPTZ(3),
    "dueAt" TIMESTAMPTZ(3),
    "status" "InailFilingStatus" NOT NULL DEFAULT 'WAITING_CERTIFICATE',
    "filedAt" TIMESTAMPTZ(3),
    "filedById" UUID,
    "protocolNumber" TEXT,
    "notNeededAt" TIMESTAMPTZ(3),
    "notNeededById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InailFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chemical" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "supplierPartyId" UUID,
    "supplierName" TEXT,
    "use" "ChemicalUse" NOT NULL,
    "ghsPictograms" "GhsPictogram"[] DEFAULT ARRAY[]::"GhsPictogram"[],
    "signalWord" "ChemicalSignalWord",
    "hazardStatements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "precautionStatements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "storagePlace" TEXT NOT NULL,
    "cabinetCode" TEXT,
    "maxQuantity" DECIMAL(18,4),
    "maxQuantityUnit" "ChemicalQuantityUnit",
    "roleSheetIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "ppeItemIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Chemical_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyDataSheet" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "chemicalId" UUID NOT NULL,
    "versionLabel" TEXT NOT NULL,
    "revisedOn" DATE NOT NULL,
    "language" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "status" "SafetyDataSheetStatus" NOT NULL DEFAULT 'CURRENT',
    "supersededAt" TIMESTAMPTZ(3),
    "supersededById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SafetyDataSheet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HealthPlan_tenantId_roleSheetId_idx" ON "HealthPlan"("tenantId", "roleSheetId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthPlan_tenantId_key_key" ON "HealthPlan"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "HealthPlan_tenantId_companyId_id_key" ON "HealthPlan"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "HealthVisit_tenantId_companyId_status_dueOn_idx" ON "HealthVisit"("tenantId", "companyId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "HealthVisit_tenantId_employeeId_idx" ON "HealthVisit"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthVisit_tenantId_employeeId_id_key" ON "HealthVisit"("tenantId", "employeeId", "id");

-- CreateIndex
CREATE INDEX "FitnessJudgement_tenantId_employeeId_judgedOn_idx" ON "FitnessJudgement"("tenantId", "employeeId", "judgedOn");

-- CreateIndex
CREATE INDEX "FitnessJudgement_tenantId_companyId_outcome_idx" ON "FitnessJudgement"("tenantId", "companyId", "outcome");

-- CreateIndex
CREATE INDEX "ProtectedView_tenantId_recordType_recordId_idx" ON "ProtectedView"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "ProtectedView_tenantId_employeeId_viewedAt_idx" ON "ProtectedView"("tenantId", "employeeId", "viewedAt");

-- CreateIndex
CREATE INDEX "ProtectedView_tenantId_viewerId_viewedAt_idx" ON "ProtectedView"("tenantId", "viewerId", "viewedAt");

-- CreateIndex
CREATE INDEX "Incident_tenantId_siteId_status_idx" ON "Incident"("tenantId", "siteId", "status");

-- CreateIndex
CREATE INDEX "Incident_tenantId_companyId_occurredAt_idx" ON "Incident"("tenantId", "companyId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_tenantId_companyId_number_key" ON "Incident"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_tenantId_siteId_id_key" ON "Incident"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "IncidentPerson_tenantId_employeeId_idx" ON "IncidentPerson"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentPerson_tenantId_incidentId_id_key" ON "IncidentPerson"("tenantId", "incidentId", "id");

-- CreateIndex
CREATE INDEX "IncidentAction_tenantId_siteId_status_idx" ON "IncidentAction"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentAction_tenantId_incidentId_seq_key" ON "IncidentAction"("tenantId", "incidentId", "seq");

-- CreateIndex
CREATE INDEX "InailFiling_tenantId_incidentId_idx" ON "InailFiling"("tenantId", "incidentId");

-- CreateIndex
CREATE INDEX "InailFiling_tenantId_status_dueAt_idx" ON "InailFiling"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "InailFiling_tenantId_key_key" ON "InailFiling"("tenantId", "key");

-- CreateIndex
CREATE INDEX "Chemical_tenantId_siteId_status_idx" ON "Chemical"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Chemical_tenantId_siteId_id_key" ON "Chemical"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "SafetyDataSheet_tenantId_chemicalId_idx" ON "SafetyDataSheet"("tenantId", "chemicalId");

-- CreateIndex
CREATE UNIQUE INDEX "RiskMeasure_tenantId_siteId_id_key" ON "RiskMeasure"("tenantId", "siteId", "id");

-- AddForeignKey
ALTER TABLE "HealthPlan" ADD CONSTRAINT "HealthPlan_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HealthPlan" ADD CONSTRAINT "HealthPlan_tenantId_siteId_roleSheetId_fkey" FOREIGN KEY ("tenantId", "siteId", "roleSheetId") REFERENCES "RoleSheet"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HealthPlan" ADD CONSTRAINT "HealthPlan_tenantId_companyId_doctorAppointmentId_fkey" FOREIGN KEY ("tenantId", "companyId", "doctorAppointmentId") REFERENCES "SafetyAppointment"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HealthVisit" ADD CONSTRAINT "HealthVisit_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HealthVisit" ADD CONSTRAINT "HealthVisit_tenantId_companyId_planId_fkey" FOREIGN KEY ("tenantId", "companyId", "planId") REFERENCES "HealthPlan"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HealthVisit" ADD CONSTRAINT "HealthVisit_tenantId_roleSheetId_fkey" FOREIGN KEY ("tenantId", "roleSheetId") REFERENCES "RoleSheet"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FitnessJudgement" ADD CONSTRAINT "FitnessJudgement_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FitnessJudgement" ADD CONSTRAINT "FitnessJudgement_tenantId_employeeId_visitId_fkey" FOREIGN KEY ("tenantId", "employeeId", "visitId") REFERENCES "HealthVisit"("tenantId", "employeeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FitnessJudgement" ADD CONSTRAINT "FitnessJudgement_tenantId_companyId_doctorAppointmentId_fkey" FOREIGN KEY ("tenantId", "companyId", "doctorAppointmentId") REFERENCES "SafetyAppointment"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProtectedView" ADD CONSTRAINT "ProtectedView_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProtectedView" ADD CONSTRAINT "ProtectedView_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_siteId_areaId_fkey" FOREIGN KEY ("tenantId", "siteId", "areaId") REFERENCES "OrgArea"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_siteId_machineId_fkey" FOREIGN KEY ("tenantId", "siteId", "machineId") REFERENCES "Machine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_siteId_maintenanceRequestId_fkey" FOREIGN KEY ("tenantId", "siteId", "maintenanceRequestId") REFERENCES "MaintenanceRequest"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_siteId_reportedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "reportedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentPerson" ADD CONSTRAINT "IncidentPerson_tenantId_siteId_incidentId_fkey" FOREIGN KEY ("tenantId", "siteId", "incidentId") REFERENCES "Incident"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentPerson" ADD CONSTRAINT "IncidentPerson_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentAction" ADD CONSTRAINT "IncidentAction_tenantId_siteId_incidentId_fkey" FOREIGN KEY ("tenantId", "siteId", "incidentId") REFERENCES "Incident"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentAction" ADD CONSTRAINT "IncidentAction_tenantId_siteId_maintenanceJobId_fkey" FOREIGN KEY ("tenantId", "siteId", "maintenanceJobId") REFERENCES "MaintenanceJob"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentAction" ADD CONSTRAINT "IncidentAction_tenantId_siteId_riskMeasureId_fkey" FOREIGN KEY ("tenantId", "siteId", "riskMeasureId") REFERENCES "RiskMeasure"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncidentAction" ADD CONSTRAINT "IncidentAction_tenantId_siteId_trainingSessionId_fkey" FOREIGN KEY ("tenantId", "siteId", "trainingSessionId") REFERENCES "TrainingSession"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InailFiling" ADD CONSTRAINT "InailFiling_tenantId_siteId_incidentId_fkey" FOREIGN KEY ("tenantId", "siteId", "incidentId") REFERENCES "Incident"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InailFiling" ADD CONSTRAINT "InailFiling_tenantId_incidentId_incidentPersonId_fkey" FOREIGN KEY ("tenantId", "incidentId", "incidentPersonId") REFERENCES "IncidentPerson"("tenantId", "incidentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Chemical" ADD CONSTRAINT "Chemical_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Chemical" ADD CONSTRAINT "Chemical_tenantId_supplierPartyId_fkey" FOREIGN KEY ("tenantId", "supplierPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyDataSheet" ADD CONSTRAINT "SafetyDataSheet_tenantId_siteId_chemicalId_fkey" FOREIGN KEY ("tenantId", "siteId", "chemicalId") REFERENCES "Chemical"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SafetyDataSheet" ADD CONSTRAINT "SafetyDataSheet_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

