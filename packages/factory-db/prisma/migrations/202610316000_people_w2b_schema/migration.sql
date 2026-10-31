-- CreateEnum
CREATE TYPE "EmployeeKind" AS ENUM ('EMPLOYEE', 'AGENCY', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'LEFT');

-- CreateEnum
CREATE TYPE "EmployeeContract" AS ENUM ('FULL_TIME', 'PART_TIME');

-- CreateEnum
CREATE TYPE "LeaverCaseStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaverStepKind" AS ENUM ('BADGE_OFF', 'BADGE_RETURNED', 'SESSIONS_ENDED', 'ACCESS_ENDED', 'WORK_HANDED_OVER', 'PPE_RETURNED', 'SHIFTS_CLEARED', 'PAYROLL_FLAGGED', 'EXIT_VISIT');

-- CreateEnum
CREATE TYPE "LeaverStepStatus" AS ENUM ('OPEN', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PeoplePurpose" AS ENUM ('ATTENDANCE', 'PERFORMANCE');

-- CreateEnum
CREATE TYPE "SkillKind" AS ENUM ('OPERATION', 'MACHINE', 'GENERAL');

-- CreateEnum
CREATE TYPE "SkillLevel" AS ENUM ('LEARNING', 'CAN_DO', 'EXPERT', 'TRAINER');

-- AlterTable
ALTER TABLE "Line" ADD COLUMN     "areaId" UUID;

-- AlterTable
ALTER TABLE "Worker" ADD COLUMN     "employeeId" UUID;

-- CreateTable
CREATE TABLE "OrgArea" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrgArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "employeeCode" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kind" "EmployeeKind" NOT NULL DEFAULT 'EMPLOYEE',
    "agencyPartyId" UUID,
    "locale" TEXT NOT NULL DEFAULT 'it',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "department" TEXT,
    "jobRole" TEXT,
    "homeLineId" UUID,
    "contract" "EmployeeContract",
    "weeklyMinutes" INTEGER,
    "defaultShiftPatternId" UUID,
    "userId" UUID,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "lineId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "since" DATE NOT NULL,
    "until" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineLoan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "fromLineId" UUID,
    "toLineId" UUID NOT NULL,
    "toTeamId" UUID,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LineLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaverCase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "employeeId" UUID NOT NULL,
    "lastWorkingDay" DATE NOT NULL,
    "status" "LeaverCaseStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedById" UUID NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LeaverCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaverStep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "caseId" UUID NOT NULL,
    "kind" "LeaverStepKind" NOT NULL,
    "seq" INTEGER NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "dueOn" DATE,
    "status" "LeaverStepStatus" NOT NULL DEFAULT 'OPEN',
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "skipReason" TEXT,
    "recordType" TEXT,
    "recordId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LeaverStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeopleSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "earlyClockInFromShiftStart" BOOLEAN NOT NULL DEFAULT true,
    "lateGraceMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeUnitMinutes" INTEGER NOT NULL DEFAULT 15,
    "roundingMinutes" INTEGER NOT NULL DEFAULT 0,
    "autoClockOutAfterMinutes" INTEGER,
    "fixedBreaks" BOOLEAN NOT NULL DEFAULT true,
    "minimumGroupSize" INTEGER NOT NULL DEFAULT 3,
    "figureRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PeopleSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeopleLegalGate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "purpose" "PeoplePurpose" NOT NULL,
    "basis" "MonitoringBasis" NOT NULL,
    "basisReference" TEXT NOT NULL,
    "basisCoversLeads" BOOLEAN NOT NULL DEFAULT false,
    "leadsSeeFigures" BOOLEAN NOT NULL DEFAULT false,
    "noticeId" UUID NOT NULL,
    "dpiaId" UUID NOT NULL,
    "switchedOnAt" TIMESTAMPTZ(3) NOT NULL,
    "switchedOnById" UUID NOT NULL,
    "switchedOffAt" TIMESTAMPTZ(3),
    "switchedOffById" UUID,
    "switchOffReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PeopleLegalGate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "kind" "SkillKind" NOT NULL,
    "operationId" UUID,
    "machineClassId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSkill" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "level" "SkillLevel" NOT NULL,
    "since" DATE NOT NULL,
    "assessedAt" TIMESTAMPTZ(3) NOT NULL,
    "assessedById" UUID NOT NULL,
    "traineeUntil" DATE,
    "signedOffOn" DATE,
    "signedOffById" UUID,
    "trainerEmployeeId" UUID,
    "removedAt" TIMESTAMPTZ(3),
    "removedById" UUID,
    "removeReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "EmployeeSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineAuthorisation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "machineClassId" UUID NOT NULL,
    "authorisedOn" DATE NOT NULL,
    "validUntil" DATE,
    "authorisedById" UUID NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "revokeReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MachineAuthorisation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgArea_tenantId_siteId_code_key" ON "OrgArea"("tenantId", "siteId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OrgArea_tenantId_siteId_id_key" ON "OrgArea"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "Employee_tenantId_siteId_idx" ON "Employee"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "Employee_tenantId_homeLineId_idx" ON "Employee"("tenantId", "homeLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_employeeCode_key" ON "Employee"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_userId_key" ON "Employee"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_id_key" ON "Employee"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_companyId_id_key" ON "Employee"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_siteId_id_key" ON "Employee"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Team_tenantId_siteId_code_key" ON "Team"("tenantId", "siteId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Team_tenantId_siteId_id_key" ON "Team"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "TeamMember_tenantId_teamId_idx" ON "TeamMember"("tenantId", "teamId");

-- CreateIndex
CREATE INDEX "TeamMember_tenantId_employeeId_idx" ON "TeamMember"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "LineLoan_tenantId_siteId_toLineId_idx" ON "LineLoan"("tenantId", "siteId", "toLineId");

-- CreateIndex
CREATE UNIQUE INDEX "LineLoan_tenantId_employeeId_startsAt_key" ON "LineLoan"("tenantId", "employeeId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "LineLoan_tenantId_employeeId_endsAt_key" ON "LineLoan"("tenantId", "employeeId", "endsAt");

-- CreateIndex
CREATE INDEX "LeaverCase_tenantId_employeeId_idx" ON "LeaverCase"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaverCase_tenantId_id_key" ON "LeaverCase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeaverStep_tenantId_caseId_seq_key" ON "LeaverStep"("tenantId", "caseId", "seq");

-- CreateIndex
CREATE INDEX "PeopleSettings_tenantId_companyId_idx" ON "PeopleSettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "PeopleLegalGate_tenantId_siteId_purpose_idx" ON "PeopleLegalGate"("tenantId", "siteId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_tenantId_code_key" ON "Skill"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_tenantId_id_key" ON "Skill"("tenantId", "id");

-- CreateIndex
CREATE INDEX "EmployeeSkill_tenantId_employeeId_idx" ON "EmployeeSkill"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "EmployeeSkill_tenantId_skillId_idx" ON "EmployeeSkill"("tenantId", "skillId");

-- CreateIndex
CREATE INDEX "EmployeeSkill_tenantId_siteId_idx" ON "EmployeeSkill"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "MachineAuthorisation_tenantId_employeeId_idx" ON "MachineAuthorisation"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "MachineAuthorisation_tenantId_machineClassId_idx" ON "MachineAuthorisation"("tenantId", "machineClassId");

-- CreateIndex
CREATE INDEX "MachineAuthorisation_tenantId_siteId_idx" ON "MachineAuthorisation"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "Line_tenantId_areaId_idx" ON "Line"("tenantId", "areaId");

-- CreateIndex
CREATE INDEX "Worker_tenantId_employeeId_idx" ON "Worker"("tenantId", "employeeId");

-- AddForeignKey
ALTER TABLE "OrgArea" ADD CONSTRAINT "OrgArea_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Line" ADD CONSTRAINT "Line_tenantId_siteId_areaId_fkey" FOREIGN KEY ("tenantId", "siteId", "areaId") REFERENCES "OrgArea"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_agencyPartyId_fkey" FOREIGN KEY ("tenantId", "agencyPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_siteId_homeLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "homeLineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_defaultShiftPatternId_fkey" FOREIGN KEY ("tenantId", "defaultShiftPatternId") REFERENCES "ShiftPattern"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_tenantId_siteId_teamId_fkey" FOREIGN KEY ("tenantId", "siteId", "teamId") REFERENCES "Team"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineLoan" ADD CONSTRAINT "LineLoan_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineLoan" ADD CONSTRAINT "LineLoan_tenantId_siteId_fromLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "fromLineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineLoan" ADD CONSTRAINT "LineLoan_tenantId_siteId_toLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "toLineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineLoan" ADD CONSTRAINT "LineLoan_tenantId_siteId_toTeamId_fkey" FOREIGN KEY ("tenantId", "siteId", "toTeamId") REFERENCES "Team"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaverCase" ADD CONSTRAINT "LeaverCase_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaverStep" ADD CONSTRAINT "LeaverStep_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "LeaverCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PeopleSettings" ADD CONSTRAINT "PeopleSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PeopleLegalGate" ADD CONSTRAINT "PeopleLegalGate_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PeopleLegalGate" ADD CONSTRAINT "PeopleLegalGate_tenantId_companyId_noticeId_fkey" FOREIGN KEY ("tenantId", "companyId", "noticeId") REFERENCES "PrivacyNotice"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PeopleLegalGate" ADD CONSTRAINT "PeopleLegalGate_tenantId_dpiaId_fkey" FOREIGN KEY ("tenantId", "dpiaId") REFERENCES "PrivacyDpia"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_tenantId_machineClassId_fkey" FOREIGN KEY ("tenantId", "machineClassId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmployeeSkill" ADD CONSTRAINT "EmployeeSkill_tenantId_siteId_employeeId_fkey" FOREIGN KEY ("tenantId", "siteId", "employeeId") REFERENCES "Employee"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSkill" ADD CONSTRAINT "EmployeeSkill_tenantId_skillId_fkey" FOREIGN KEY ("tenantId", "skillId") REFERENCES "Skill"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmployeeSkill" ADD CONSTRAINT "EmployeeSkill_tenantId_trainerEmployeeId_fkey" FOREIGN KEY ("tenantId", "trainerEmployeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineAuthorisation" ADD CONSTRAINT "MachineAuthorisation_tenantId_siteId_employeeId_fkey" FOREIGN KEY ("tenantId", "siteId", "employeeId") REFERENCES "Employee"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineAuthorisation" ADD CONSTRAINT "MachineAuthorisation_tenantId_machineClassId_fkey" FOREIGN KEY ("tenantId", "machineClassId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

