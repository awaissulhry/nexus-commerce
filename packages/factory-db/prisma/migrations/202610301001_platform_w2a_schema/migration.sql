-- CreateEnum
CREATE TYPE "AlertTrigger" AS ENUM ('CONDITION', 'DATE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AlertResolution" AS ENUM ('HANDLED', 'CLEARED');

-- CreateEnum
CREATE TYPE "AlertVerb" AS ENUM ('RAISED', 'ACKNOWLEDGED', 'ASSIGNED', 'UNASSIGNED', 'SNOOZED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DueTimerStatus" AS ENUM ('PENDING', 'FIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CalendarScope" AS ENUM ('COMPANY', 'SITE', 'LINE', 'WORK_CENTRE', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "CalendarDayKind" AS ENUM ('HOLIDAY', 'CLOSURE', 'WORKING');

-- CreateEnum
CREATE TYPE "ShiftSegmentKind" AS ENUM ('SHIFT', 'BREAK');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('MENTION', 'ASSIGNMENT', 'APPROVAL', 'ALERT', 'FOLLOWING', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationDeliveryOutcome" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "FollowReason" AS ENUM ('CREATOR', 'ASSIGNEE', 'MENTIONED', 'CHOSE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('NOT_SCANNED', 'PENDING', 'CLEAN', 'INFECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "RestoreDrillResult" AS ENUM ('PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReasonList" AS ENUM ('PAUSE', 'DOWNTIME', 'HELP_CALL', 'ADJUSTMENT', 'HOLD', 'CANCEL', 'WRITE_OFF', 'RETURN', 'DISCREPANCY', 'CLAIM', 'DOWNGRADE');

-- CreateEnum
CREATE TYPE "SavedViewAudience" AS ENUM ('ONLY_ME', 'EVERYONE', 'ROLE');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'XLSX', 'XLSX_REIMPORT');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReportChannel" AS ENUM ('EMAIL');

-- AlterEnum
ALTER TYPE "AttentionVerb" ADD VALUE 'SNOOZED';

-- AlterTable
ALTER TABLE "AttentionAction" ADD COLUMN     "snoozedAt" TIMESTAMPTZ(3),
ADD COLUMN     "snoozedById" UUID,
ADD COLUMN     "snoozedCondition" TEXT,
ADD COLUMN     "snoozedUntil" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "AttentionActionLog" ADD COLUMN     "snoozedUntil" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "batteryCharging" BOOLEAN,
ADD COLUMN     "batteryPercent" INTEGER,
ADD COLUMN     "queuedActions" INTEGER,
ADD COLUMN     "statusReportedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "floorLocales" TEXT[] DEFAULT ARRAY['it', 'en']::TEXT[];

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "scanEngine" TEXT,
ADD COLUMN     "scanFinding" TEXT,
ADD COLUMN     "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "scannedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "ruleKind" TEXT NOT NULL,
    "trigger" "AlertTrigger" NOT NULL,
    "name" TEXT NOT NULL,
    "threshold" JSONB NOT NULL DEFAULT '{}',
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "companyId" UUID,
    "siteId" UUID,
    "recipientRoleId" UUID,
    "channels" "AlertChannel"[] DEFAULT ARRAY['IN_APP']::"AlertChannel"[],
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 1440,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "ruleId" UUID NOT NULL,
    "ruleKind" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "state" "AlertState" NOT NULL DEFAULT 'OPEN',
    "raisedAt" TIMESTAMPTZ(3) NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedById" UUID,
    "assignedToId" UUID,
    "assignedById" UUID,
    "assignedAt" TIMESTAMPTZ(3),
    "snoozedUntil" TIMESTAMPTZ(3),
    "snoozedById" UUID,
    "snoozedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" "AlertResolution",
    "resolvedById" UUID,
    "resolveNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "alertId" UUID NOT NULL,
    "verb" "AlertVerb" NOT NULL,
    "actorId" UUID,
    "assigneeId" UUID,
    "snoozedUntil" TIMESTAMPTZ(3),
    "note" TEXT,
    "facts" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DueTimer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "timerKey" TEXT NOT NULL,
    "ruleId" UUID,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "recordLabel" TEXT,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "fireAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "DueTimerStatus" NOT NULL DEFAULT 'PENDING',
    "firedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DueTimer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkCalendar" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "scope" "CalendarScope" NOT NULL,
    "companyId" UUID,
    "siteId" UUID,
    "lineId" UUID,
    "workCentreId" UUID,
    "partyId" UUID,
    "name" TEXT NOT NULL,
    "workingWeekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "shiftPatternId" UUID,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarDay" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "calendarId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "CalendarDayKind" NOT NULL,
    "name" TEXT NOT NULL,
    "shiftPatternId" UUID,
    "note" TEXT,
    "holidaySet" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CalendarDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftPattern" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShiftPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSegment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "patternId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "kind" "ShiftSegmentKind" NOT NULL,
    "label" TEXT,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShiftSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "companyId" UUID,
    "category" "NotificationCategory" NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "anchor" TEXT,
    "messageKey" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "actorId" UUID,
    "groupKey" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "snoozedAt" TIMESTAMPTZ(3),
    "snoozedUntil" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "notificationId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "outcome" "NotificationDeliveryOutcome" NOT NULL,
    "emailOutboundId" UUID,
    "detail" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordFollower" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" "FollowReason" NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RecordFollower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageMention" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "messageId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "authorId" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "recordType" TEXT,
    "recordId" UUID,
    "recordLabel" TEXT,
    "assigneeId" UUID,
    "assignedById" UUID,
    "assignedAt" TIMESTAMPTZ(3),
    "dueDate" DATE,
    "dueTime" TEXT,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "snoozedUntil" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestoreDrill" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "drilledOn" DATE NOT NULL,
    "environment" TEXT NOT NULL,
    "backupAt" TIMESTAMPTZ(3),
    "checks" JSONB NOT NULL,
    "result" "RestoreDrillResult" NOT NULL,
    "durationMinutes" INTEGER,
    "notes" TEXT,
    "evidenceFileId" UUID,
    "performedById" UUID NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestoreDrill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReasonCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "list" "ReasonList" NOT NULL,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "icon" TEXT,
    "colour" TEXT,
    "needsDetail" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReasonCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "number" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "status" TEXT,
    "area" TEXT NOT NULL,
    "viewPermission" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "indexedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "listKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "audience" "SavedViewAudience" NOT NULL DEFAULT 'ONLY_ME',
    "roleId" UUID,
    "roleDefault" BOOLEAN NOT NULL DEFAULT false,
    "companyId" UUID,
    "state" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "requestedById" UUID NOT NULL,
    "listKey" TEXT NOT NULL,
    "viewId" UUID,
    "format" "ExportFormat" NOT NULL,
    "query" JSONB NOT NULL,
    "omittedColumns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "rowsDone" INTEGER NOT NULL DEFAULT 0,
    "rowCount" INTEGER,
    "fileId" UUID,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "emailedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSubscription" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "companyId" UUID,
    "siteId" UUID,
    "params" JSONB NOT NULL DEFAULT '{}',
    "channel" "ReportChannel" NOT NULL DEFAULT 'EMAIL',
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "sendTime" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReportSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertRule_tenantId_ruleKind_idx" ON "AlertRule"("tenantId", "ruleKind");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRule_tenantId_id_key" ON "AlertRule"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Alert_tenantId_state_raisedAt_idx" ON "Alert"("tenantId", "state", "raisedAt");

-- CreateIndex
CREATE INDEX "Alert_tenantId_recordType_recordId_idx" ON "Alert"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "Alert_tenantId_assignedToId_idx" ON "Alert"("tenantId", "assignedToId");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_tenantId_dedupeKey_occurrence_key" ON "Alert"("tenantId", "dedupeKey", "occurrence");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_tenantId_id_key" ON "Alert"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AlertEvent_tenantId_alertId_at_idx" ON "AlertEvent"("tenantId", "alertId", "at");

-- CreateIndex
CREATE INDEX "DueTimer_tenantId_status_fireAt_idx" ON "DueTimer"("tenantId", "status", "fireAt");

-- CreateIndex
CREATE INDEX "DueTimer_tenantId_recordType_recordId_idx" ON "DueTimer"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "WorkCalendar_tenantId_companyId_idx" ON "WorkCalendar"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "WorkCalendar_tenantId_siteId_idx" ON "WorkCalendar"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "WorkCalendar_tenantId_partyId_idx" ON "WorkCalendar"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkCalendar_tenantId_id_key" ON "WorkCalendar"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CalendarDay_tenantId_date_idx" ON "CalendarDay"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarDay_tenantId_calendarId_date_key" ON "CalendarDay"("tenantId", "calendarId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftPattern_tenantId_code_key" ON "ShiftPattern"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftPattern_tenantId_id_key" ON "ShiftPattern"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ShiftSegment_tenantId_patternId_weekday_idx" ON "ShiftSegment"("tenantId", "patternId", "weekday");

-- CreateIndex
CREATE INDEX "Notification_tenantId_userId_createdAt_idx" ON "Notification"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_recordType_recordId_idx" ON "Notification"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_userId_eventType_eventId_key" ON "Notification"("tenantId", "userId", "eventType", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_id_key" ON "Notification"("tenantId", "id");

-- CreateIndex
CREATE INDEX "NotificationDelivery_tenantId_notificationId_idx" ON "NotificationDelivery"("tenantId", "notificationId");

-- CreateIndex
CREATE INDEX "RecordFollower_tenantId_userId_idx" ON "RecordFollower"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordFollower_tenantId_recordType_recordId_userId_key" ON "RecordFollower"("tenantId", "recordType", "recordId", "userId");

-- CreateIndex
CREATE INDEX "MessageMention_tenantId_userId_at_idx" ON "MessageMention"("tenantId", "userId", "at");

-- CreateIndex
CREATE INDEX "MessageMention_tenantId_messageId_idx" ON "MessageMention"("tenantId", "messageId");

-- CreateIndex
CREATE INDEX "Task_tenantId_assigneeId_status_dueDate_idx" ON "Task"("tenantId", "assigneeId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Task_tenantId_recordType_recordId_idx" ON "Task"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "Task_tenantId_createdById_idx" ON "Task"("tenantId", "createdById");

-- CreateIndex
CREATE INDEX "RestoreDrill_tenantId_drilledOn_idx" ON "RestoreDrill"("tenantId", "drilledOn");

-- CreateIndex
CREATE UNIQUE INDEX "ReasonCode_tenantId_list_code_key" ON "ReasonCode"("tenantId", "list", "code");

-- CreateIndex
CREATE INDEX "SearchEntry_searchText_idx" ON "SearchEntry" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "SearchEntry_tenantId_number_idx" ON "SearchEntry"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SearchEntry_tenantId_recordType_recordId_key" ON "SearchEntry"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "SavedView_tenantId_listKey_idx" ON "SavedView"("tenantId", "listKey");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_tenantId_ownerId_listKey_name_key" ON "SavedView"("tenantId", "ownerId", "listKey", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_tenantId_id_key" ON "SavedView"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ExportJob_tenantId_requestedById_createdAt_idx" ON "ExportJob"("tenantId", "requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "ExportJob_tenantId_status_idx" ON "ExportJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ReportSubscription_tenantId_userId_idx" ON "ReportSubscription"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "ReportSubscription_tenantId_active_idx" ON "ReportSubscription"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_id_key" ON "Message"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_tenantId_recipientRoleId_fkey" FOREIGN KEY ("tenantId", "recipientRoleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_tenantId_ruleId_fkey" FOREIGN KEY ("tenantId", "ruleId") REFERENCES "AlertRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_tenantId_assignedToId_fkey" FOREIGN KEY ("tenantId", "assignedToId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_tenantId_alertId_fkey" FOREIGN KEY ("tenantId", "alertId") REFERENCES "Alert"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DueTimer" ADD CONSTRAINT "DueTimer_tenantId_ruleId_fkey" FOREIGN KEY ("tenantId", "ruleId") REFERENCES "AlertRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCalendar" ADD CONSTRAINT "WorkCalendar_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCalendar" ADD CONSTRAINT "WorkCalendar_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCalendar" ADD CONSTRAINT "WorkCalendar_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCalendar" ADD CONSTRAINT "WorkCalendar_tenantId_siteId_workCentreId_fkey" FOREIGN KEY ("tenantId", "siteId", "workCentreId") REFERENCES "WorkCentre"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCalendar" ADD CONSTRAINT "WorkCalendar_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkCalendar" ADD CONSTRAINT "WorkCalendar_tenantId_shiftPatternId_fkey" FOREIGN KEY ("tenantId", "shiftPatternId") REFERENCES "ShiftPattern"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CalendarDay" ADD CONSTRAINT "CalendarDay_tenantId_calendarId_fkey" FOREIGN KEY ("tenantId", "calendarId") REFERENCES "WorkCalendar"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CalendarDay" ADD CONSTRAINT "CalendarDay_tenantId_shiftPatternId_fkey" FOREIGN KEY ("tenantId", "shiftPatternId") REFERENCES "ShiftPattern"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShiftPattern" ADD CONSTRAINT "ShiftPattern_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShiftSegment" ADD CONSTRAINT "ShiftSegment_tenantId_patternId_fkey" FOREIGN KEY ("tenantId", "patternId") REFERENCES "ShiftPattern"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_tenantId_notificationId_fkey" FOREIGN KEY ("tenantId", "notificationId") REFERENCES "Notification"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordFollower" ADD CONSTRAINT "RecordFollower_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_tenantId_messageId_fkey" FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_tenantId_threadId_fkey" FOREIGN KEY ("tenantId", "threadId") REFERENCES "Thread"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_assigneeId_fkey" FOREIGN KEY ("tenantId", "assigneeId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RestoreDrill" ADD CONSTRAINT "RestoreDrill_tenantId_evidenceFileId_fkey" FOREIGN KEY ("tenantId", "evidenceFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_tenantId_ownerId_fkey" FOREIGN KEY ("tenantId", "ownerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_tenantId_viewId_fkey" FOREIGN KEY ("tenantId", "viewId") REFERENCES "SavedView"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReportSubscription" ADD CONSTRAINT "ReportSubscription_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReportSubscription" ADD CONSTRAINT "ReportSubscription_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReportSubscription" ADD CONSTRAINT "ReportSubscription_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

