-- CreateEnum
CREATE TYPE "PartnerTaskKind" AS ENUM ('CONFIRM_PO', 'ACCEPT_QUOTE', 'APPROVE', 'SEND_MEASUREMENTS', 'UPLOAD_DOCUMENT', 'ANSWER_MESSAGE', 'PAY_INVOICE', 'CONFIRM_KIT', 'REPORT_PROGRESS', 'ANSWER_QUESTIONNAIRE', 'RECONFIRM_ORDER');

-- CreateEnum
CREATE TYPE "PartnerTaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PartnerEmailTopic" AS ENUM ('ORDERS', 'DATES', 'SHIPPED', 'INVOICES', 'CLAIMS', 'DOCUMENTS', 'MESSAGES', 'REMINDERS');

-- CreateEnum
CREATE TYPE "PartnerEmailFrequency" AS ENUM ('INSTANT', 'DAILY', 'WEEKLY', 'OFF');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'EMAIL_DIGEST';

-- AlterTable
ALTER TABLE "Message" ALTER COLUMN "mentionedUserIds" SET DEFAULT ('{}'::text)::uuid[],
ALTER COLUMN "forFloor" SET DEFAULT ('false'::text)::boolean;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "partyId" UUID;

-- CreateTable
CREATE TABLE "PartnerTask" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "kind" "PartnerTaskKind" NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3),
    "askedById" UUID,
    "askedByName" TEXT,
    "status" "PartnerTaskStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "remindedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerEmailPreference" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topic" "PartnerEmailTopic" NOT NULL,
    "frequency" "PartnerEmailFrequency" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerEmailPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerTask_tenantId_partyId_status_dueAt_idx" ON "PartnerTask"("tenantId", "partyId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "PartnerTask_tenantId_status_dueAt_idx" ON "PartnerTask"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTask_tenantId_recordType_recordId_kind_sourceKey_key" ON "PartnerTask"("tenantId", "recordType", "recordId", "kind", "sourceKey");

-- CreateIndex
CREATE INDEX "PartnerEmailPreference_tenantId_userId_idx" ON "PartnerEmailPreference"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_partyId_idx" ON "Notification"("tenantId", "partyId");

-- AddForeignKey
ALTER TABLE "PartnerTask" ADD CONSTRAINT "PartnerTask_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartnerTask" ADD CONSTRAINT "PartnerTask_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartnerTask" ADD CONSTRAINT "PartnerTask_tenantId_doneById_fkey" FOREIGN KEY ("tenantId", "doneById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartnerEmailPreference" ADD CONSTRAINT "PartnerEmailPreference_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

