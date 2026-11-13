-- CreateEnum
CREATE TYPE "EmailBounceKind" AS ENUM ('PERMANENT', 'TRANSIENT', 'UNDETERMINED');

-- CreateEnum
CREATE TYPE "NotificationEventKind" AS ENUM ('MENTIONED', 'ASSIGNED', 'APPROVAL_WAITING', 'APPROVAL_DECIDED', 'FOLLOWING_CHANGED', 'AREA_ALERT', 'MAIL_ASSIGNED');

-- CreateEnum
CREATE TYPE "NotificationPreferenceChannel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationCadence" AS ENUM ('INSTANT', 'DAILY_DIGEST', 'OFF');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('AT_TIME', 'ON_CHANGE');

-- AlterTable
ALTER TABLE "EmailOutbound" ADD COLUMN     "bounceKind" "EmailBounceKind";

-- AlterTable
ALTER TABLE "InboundEmail" ADD COLUMN     "assignedAt" TIMESTAMPTZ(3),
ADD COLUMN     "assigneeId" UUID,
ADD COLUMN     "closedAt" TIMESTAMPTZ(3),
ADD COLUMN     "closedById" UUID,
ADD COLUMN     "followUpUntil" TIMESTAMPTZ(3),
ADD COLUMN     "snoozedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "teamInboxId" UUID;

-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "inquiryAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "event" "NotificationEventKind" NOT NULL,
    "channel" "NotificationPreferenceChannel" NOT NULL,
    "cadence" "NotificationCadence" NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleNotificationDefault" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "roleId" UUID NOT NULL,
    "event" "NotificationEventKind" NOT NULL,
    "channel" "NotificationPreferenceChannel" NOT NULL,
    "cadence" "NotificationCadence" NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RoleNotificationDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keysSecretId" UUID,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ViewFollower" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "viewId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "lastFingerprint" TEXT,
    "lastCount" INTEGER,
    "lastCountedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ViewFollower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "companyId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "messageId" UUID,
    "kind" "ReminderKind" NOT NULL,
    "remindAt" TIMESTAMPTZ(3),
    "since" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "cameBackAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamInbox" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "localPart" TEXT NOT NULL,
    "memberIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TeamInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureAddress" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "defaultTeamInboxId" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CaptureAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationPreference_tenantId_userId_idx" ON "NotificationPreference"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_tenantId_key_key" ON "NotificationPreference"("tenantId", "key");

-- CreateIndex
CREATE INDEX "RoleNotificationDefault_tenantId_roleId_idx" ON "RoleNotificationDefault"("tenantId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleNotificationDefault_tenantId_key_key" ON "RoleNotificationDefault"("tenantId", "key");

-- CreateIndex
CREATE INDEX "PushSubscription_tenantId_userId_idx" ON "PushSubscription"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_tenantId_keysSecretId_key" ON "PushSubscription"("tenantId", "keysSecretId");

-- CreateIndex
CREATE INDEX "ViewFollower_tenantId_userId_idx" ON "ViewFollower"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "ViewFollower_tenantId_viewId_idx" ON "ViewFollower"("tenantId", "viewId");

-- CreateIndex
CREATE UNIQUE INDEX "ViewFollower_tenantId_key_key" ON "ViewFollower"("tenantId", "key");

-- CreateIndex
CREATE INDEX "Reminder_tenantId_userId_doneAt_idx" ON "Reminder"("tenantId", "userId", "doneAt");

-- CreateIndex
CREATE INDEX "Reminder_tenantId_remindAt_idx" ON "Reminder"("tenantId", "remindAt");

-- CreateIndex
CREATE INDEX "Reminder_tenantId_recordType_recordId_idx" ON "Reminder"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamInbox_tenantId_companyId_name_key" ON "TeamInbox"("tenantId", "companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TeamInbox_tenantId_companyId_localPart_key" ON "TeamInbox"("tenantId", "companyId", "localPart");

-- CreateIndex
CREATE UNIQUE INDEX "TeamInbox_tenantId_id_key" ON "TeamInbox"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TeamInbox_tenantId_companyId_id_key" ON "TeamInbox"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "CaptureAddress_tenantId_companyId_idx" ON "CaptureAddress"("tenantId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CaptureAddress_token_key" ON "CaptureAddress"("token");

-- CreateIndex
CREATE INDEX "InboundEmail_tenantId_teamInboxId_closedAt_idx" ON "InboundEmail"("tenantId", "teamInboxId", "closedAt");

-- CreateIndex
CREATE INDEX "InboundEmail_tenantId_assigneeId_idx" ON "InboundEmail"("tenantId", "assigneeId");

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_tenantId_teamInboxId_fkey" FOREIGN KEY ("tenantId", "teamInboxId") REFERENCES "TeamInbox"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_tenantId_assigneeId_fkey" FOREIGN KEY ("tenantId", "assigneeId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleNotificationDefault" ADD CONSTRAINT "RoleNotificationDefault_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_tenantId_keysSecretId_fkey" FOREIGN KEY ("tenantId", "keysSecretId") REFERENCES "SecretValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ViewFollower" ADD CONSTRAINT "ViewFollower_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ViewFollower" ADD CONSTRAINT "ViewFollower_tenantId_viewId_fkey" FOREIGN KEY ("tenantId", "viewId") REFERENCES "SavedView"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_tenantId_messageId_fkey" FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TeamInbox" ADD CONSTRAINT "TeamInbox_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CaptureAddress" ADD CONSTRAINT "CaptureAddress_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CaptureAddress" ADD CONSTRAINT "CaptureAddress_tenantId_companyId_defaultTeamInboxId_fkey" FOREIGN KEY ("tenantId", "companyId", "defaultTeamInboxId") REFERENCES "TeamInbox"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

