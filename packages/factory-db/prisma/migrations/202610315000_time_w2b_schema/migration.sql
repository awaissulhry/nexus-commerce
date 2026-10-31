-- CreateEnum
CREATE TYPE "RosterEntryKind" AS ENUM ('WORK', 'OFF');

-- CreateEnum
CREATE TYPE "RosterEntryStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "OvertimeRequestStatus" AS ENUM ('DRAFT', 'ASKED', 'AGREED', 'APPROVED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OvertimeAnswer" AS ENUM ('PENDING', 'AGREED', 'DECLINED');

-- CreateEnum
CREATE TYPE "OvertimeAnswerChannel" AS ENUM ('FLOOR', 'OFFICE');

-- CreateEnum
CREATE TYPE "ClockEventKind" AS ENUM ('IN', 'OUT', 'BREAK_OUT', 'BREAK_IN', 'VOID');

-- CreateEnum
CREATE TYPE "ClockEventSource" AS ENUM ('BADGE', 'NAME_PIN', 'OFFLINE', 'MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "ClockEventFlag" AS ENUM ('FORGOT_BADGE', 'CLOCK_SKEW');

-- CreateEnum
CREATE TYPE "AttendanceDayStatus" AS ENUM ('OPEN', 'NEEDS_FIX', 'APPROVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AttendanceAnomalyKind" AS ENUM ('MISSING_CLOCK_OUT', 'MISSING_CLOCK_IN', 'DOUBLE_CLOCK_IN', 'LONG_DAY', 'NO_SHIFT', 'SCANS_WITHOUT_CLOCK_IN', 'FLAGGED_EVENT', 'SHORT_REST', 'NO_BREAK');

-- CreateEnum
CREATE TYPE "AnomalyResolution" AS ENUM ('FIXED', 'ACCEPTED', 'CLEARED');

-- CreateEnum
CREATE TYPE "AbsenceCategory" AS ENUM ('HOLIDAY', 'PERMIT', 'SICKNESS', 'INJURY', 'PARENTAL', 'LAW_104', 'UNION', 'STRIKE', 'UNPAID_LEAVE', 'OTHER');

-- CreateEnum
CREATE TYPE "OvertimeClass" AS ENUM ('DAY', 'NIGHT', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "OvertimeEntryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TimesheetStatus" AS ENUM ('PENDING', 'LEAD_APPROVED', 'APPROVED');

-- CreateEnum
CREATE TYPE "AttendanceMonthStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AttendanceCorrectionKind" AS ENUM ('PRESENT', 'ORDINARY', 'NIGHT', 'HOLIDAY', 'OVERTIME_DAY', 'OVERTIME_NIGHT', 'OVERTIME_HOLIDAY', 'ABSENCE');

-- CreateEnum
CREATE TYPE "WorkingTimeRuleKind" AS ENUM ('DAILY_REST', 'WEEKLY_REST', 'WEEKLY_AVERAGE', 'BREAK_AFTER', 'OVERTIME_YEARLY_CAP', 'NIGHT_AVERAGE');

-- CreateEnum
CREATE TYPE "WorkingTimeAction" AS ENUM ('WARN', 'BLOCK');

-- CreateEnum
CREATE TYPE "WorkingTimeRuleSource" AS ENUM ('LAW', 'CCNL');

-- CreateTable
CREATE TABLE "RosterEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "RosterEntryKind" NOT NULL,
    "shiftPatternId" UUID,
    "shiftLabel" TEXT,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" "RosterEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RosterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OvertimeRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "lineId" UUID,
    "date" DATE NOT NULL,
    "startMinute" INTEGER,
    "minutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "OvertimeRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "askedAt" TIMESTAMPTZ(3),
    "askedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OvertimeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OvertimeAgreement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "answer" "OvertimeAnswer" NOT NULL DEFAULT 'PENDING',
    "answeredAt" TIMESTAMPTZ(3),
    "answeredVia" "OvertimeAnswerChannel",
    "workerId" UUID,
    "deviceId" UUID,
    "answeredById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OvertimeAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClockEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "workerId" UUID,
    "deviceId" UUID,
    "kind" "ClockEventKind" NOT NULL,
    "source" "ClockEventSource" NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "deviceTime" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flags" "ClockEventFlag"[] DEFAULT ARRAY[]::"ClockEventFlag"[],
    "clientEventId" TEXT,
    "reason" TEXT,
    "offSite" BOOLEAN NOT NULL DEFAULT false,
    "voidsEventId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ClockEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDay" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceDayStatus" NOT NULL DEFAULT 'OPEN',
    "plannedLabel" TEXT,
    "plannedStartMinute" INTEGER,
    "plannedEndMinute" INTEGER,
    "plannedMinutes" INTEGER,
    "firstInAt" TIMESTAMPTZ(3),
    "lastOutAt" TIMESTAMPTZ(3),
    "presentMinutes" INTEGER NOT NULL DEFAULT 0,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "ordinaryMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "nightMinutes" INTEGER NOT NULL DEFAULT 0,
    "holidayMinutes" INTEGER NOT NULL DEFAULT 0,
    "absenceMinutes" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMPTZ(3),
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "monthCloseId" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AttendanceDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceAnomaly" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "dayId" UUID NOT NULL,
    "kind" "AttendanceAnomalyKind" NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "workingTimeRuleId" UUID,
    "clockEventId" UUID,
    "detail" JSONB,
    "raisedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" "AnomalyResolution",
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "resolutionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AttendanceAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbsenceCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL,
    "category" "AbsenceCategory" NOT NULL,
    "lulCode" TEXT,
    "paid" BOOLEAN NOT NULL,
    "documentRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AbsenceCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbsenceEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "codeId" UUID NOT NULL,
    "minutes" INTEGER NOT NULL,
    "documentRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AbsenceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OvertimeEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "OvertimeClass" NOT NULL,
    "minutes" INTEGER NOT NULL,
    "requestId" UUID,
    "status" "OvertimeEntryStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectedById" UUID,
    "rejectReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OvertimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetApproval" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "TimesheetStatus" NOT NULL DEFAULT 'PENDING',
    "leadApprovedAt" TIMESTAMPTZ(3),
    "leadApprovedById" UUID,
    "hrApprovedAt" TIMESTAMPTZ(3),
    "hrApprovedById" UUID,
    "returnedAt" TIMESTAMPTZ(3),
    "returnedById" UUID,
    "returnReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TimesheetApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceMonthClose" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "status" "AttendanceMonthStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "lulFileId" UUID,
    "lulSha256" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AttendanceMonthClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCorrection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "dayId" UUID NOT NULL,
    "monthCloseId" UUID NOT NULL,
    "kind" "AttendanceCorrectionKind" NOT NULL,
    "absenceCodeId" UUID,
    "minutesBefore" INTEGER NOT NULL,
    "minutesAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkingTimeRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "siteId" UUID,
    "kind" "WorkingTimeRuleKind" NOT NULL,
    "limitMinutes" INTEGER NOT NULL,
    "breakMinutes" INTEGER,
    "referenceMonths" INTEGER,
    "action" "WorkingTimeAction" NOT NULL DEFAULT 'WARN',
    "alertRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "WorkingTimeRuleSource" NOT NULL DEFAULT 'LAW',
    "legalReference" TEXT NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkingTimeRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RosterEntry_tenantId_siteId_date_idx" ON "RosterEntry"("tenantId", "siteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RosterEntry_tenantId_employeeId_date_key" ON "RosterEntry"("tenantId", "employeeId", "date");

-- CreateIndex
CREATE INDEX "OvertimeRequest_tenantId_siteId_date_idx" ON "OvertimeRequest"("tenantId", "siteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "OvertimeRequest_tenantId_siteId_id_key" ON "OvertimeRequest"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "OvertimeAgreement_tenantId_requestId_idx" ON "OvertimeAgreement"("tenantId", "requestId");

-- CreateIndex
CREATE INDEX "OvertimeAgreement_tenantId_employeeId_idx" ON "OvertimeAgreement"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "ClockEvent_tenantId_employeeId_occurredAt_idx" ON "ClockEvent"("tenantId", "employeeId", "occurredAt");

-- CreateIndex
CREATE INDEX "ClockEvent_tenantId_siteId_occurredAt_idx" ON "ClockEvent"("tenantId", "siteId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClockEvent_tenantId_deviceId_clientEventId_key" ON "ClockEvent"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockEvent_tenantId_voidsEventId_key" ON "ClockEvent"("tenantId", "voidsEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockEvent_tenantId_employeeId_id_key" ON "ClockEvent"("tenantId", "employeeId", "id");

-- CreateIndex
CREATE INDEX "AttendanceDay_tenantId_companyId_date_idx" ON "AttendanceDay"("tenantId", "companyId", "date");

-- CreateIndex
CREATE INDEX "AttendanceDay_tenantId_siteId_date_idx" ON "AttendanceDay"("tenantId", "siteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDay_tenantId_employeeId_date_key" ON "AttendanceDay"("tenantId", "employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDay_tenantId_employeeId_id_key" ON "AttendanceDay"("tenantId", "employeeId", "id");

-- CreateIndex
CREATE INDEX "AttendanceAnomaly_tenantId_dayId_idx" ON "AttendanceAnomaly"("tenantId", "dayId");

-- CreateIndex
CREATE INDEX "AttendanceAnomaly_tenantId_companyId_resolvedAt_idx" ON "AttendanceAnomaly"("tenantId", "companyId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbsenceCode_tenantId_code_key" ON "AbsenceCode"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AbsenceCode_tenantId_id_key" ON "AbsenceCode"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AbsenceEntry_tenantId_companyId_date_idx" ON "AbsenceEntry"("tenantId", "companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AbsenceEntry_tenantId_employeeId_date_codeId_key" ON "AbsenceEntry"("tenantId", "employeeId", "date", "codeId");

-- CreateIndex
CREATE INDEX "OvertimeEntry_tenantId_companyId_date_idx" ON "OvertimeEntry"("tenantId", "companyId", "date");

-- CreateIndex
CREATE INDEX "OvertimeEntry_tenantId_requestId_idx" ON "OvertimeEntry"("tenantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "OvertimeEntry_tenantId_employeeId_date_kind_key" ON "OvertimeEntry"("tenantId", "employeeId", "date", "kind");

-- CreateIndex
CREATE INDEX "TimesheetApproval_tenantId_companyId_periodStart_idx" ON "TimesheetApproval"("tenantId", "companyId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetApproval_tenantId_employeeId_periodStart_periodEnd_key" ON "TimesheetApproval"("tenantId", "employeeId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceMonthClose_tenantId_companyId_month_key" ON "AttendanceMonthClose"("tenantId", "companyId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceMonthClose_tenantId_companyId_id_key" ON "AttendanceMonthClose"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_tenantId_dayId_idx" ON "AttendanceCorrection"("tenantId", "dayId");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_tenantId_companyId_createdAt_idx" ON "AttendanceCorrection"("tenantId", "companyId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkingTimeRule_tenantId_companyId_idx" ON "WorkingTimeRule"("tenantId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkingTimeRule_tenantId_id_key" ON "WorkingTimeRule"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "RosterEntry" ADD CONSTRAINT "RosterEntry_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RosterEntry" ADD CONSTRAINT "RosterEntry_tenantId_shiftPatternId_fkey" FOREIGN KEY ("tenantId", "shiftPatternId") REFERENCES "ShiftPattern"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OvertimeAgreement" ADD CONSTRAINT "OvertimeAgreement_tenantId_siteId_requestId_fkey" FOREIGN KEY ("tenantId", "siteId", "requestId") REFERENCES "OvertimeRequest"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OvertimeAgreement" ADD CONSTRAINT "OvertimeAgreement_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OvertimeAgreement" ADD CONSTRAINT "OvertimeAgreement_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_tenantId_employeeId_voidsEventId_fkey" FOREIGN KEY ("tenantId", "employeeId", "voidsEventId") REFERENCES "ClockEvent"("tenantId", "employeeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_tenantId_companyId_monthCloseId_fkey" FOREIGN KEY ("tenantId", "companyId", "monthCloseId") REFERENCES "AttendanceMonthClose"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceAnomaly" ADD CONSTRAINT "AttendanceAnomaly_tenantId_employeeId_dayId_fkey" FOREIGN KEY ("tenantId", "employeeId", "dayId") REFERENCES "AttendanceDay"("tenantId", "employeeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceAnomaly" ADD CONSTRAINT "AttendanceAnomaly_tenantId_employeeId_clockEventId_fkey" FOREIGN KEY ("tenantId", "employeeId", "clockEventId") REFERENCES "ClockEvent"("tenantId", "employeeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceAnomaly" ADD CONSTRAINT "AttendanceAnomaly_tenantId_workingTimeRuleId_fkey" FOREIGN KEY ("tenantId", "workingTimeRuleId") REFERENCES "WorkingTimeRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AbsenceCode" ADD CONSTRAINT "AbsenceCode_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AbsenceEntry" ADD CONSTRAINT "AbsenceEntry_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AbsenceEntry" ADD CONSTRAINT "AbsenceEntry_tenantId_codeId_fkey" FOREIGN KEY ("tenantId", "codeId") REFERENCES "AbsenceCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OvertimeEntry" ADD CONSTRAINT "OvertimeEntry_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OvertimeEntry" ADD CONSTRAINT "OvertimeEntry_tenantId_siteId_requestId_fkey" FOREIGN KEY ("tenantId", "siteId", "requestId") REFERENCES "OvertimeRequest"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TimesheetApproval" ADD CONSTRAINT "TimesheetApproval_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceMonthClose" ADD CONSTRAINT "AttendanceMonthClose_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceMonthClose" ADD CONSTRAINT "AttendanceMonthClose_tenantId_lulFileId_fkey" FOREIGN KEY ("tenantId", "lulFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_tenantId_employeeId_dayId_fkey" FOREIGN KEY ("tenantId", "employeeId", "dayId") REFERENCES "AttendanceDay"("tenantId", "employeeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_tenantId_companyId_monthCloseId_fkey" FOREIGN KEY ("tenantId", "companyId", "monthCloseId") REFERENCES "AttendanceMonthClose"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_tenantId_absenceCodeId_fkey" FOREIGN KEY ("tenantId", "absenceCodeId") REFERENCES "AbsenceCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkingTimeRule" ADD CONSTRAINT "WorkingTimeRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkingTimeRule" ADD CONSTRAINT "WorkingTimeRule_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

