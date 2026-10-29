-- CreateEnum
CREATE TYPE "PrivacyNoticeKind" AS ENUM ('WORKER_FLOOR', 'OFFICE_STAFF', 'PRIVACY_PUBLIC');

-- CreateEnum
CREATE TYPE "PrivacyNoticeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PrivacyDpiaStatus" AS ENUM ('DRAFT', 'STORED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ProcessingActivityStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "WorkerNoticeAck" ADD COLUMN     "noticeId" UUID;

-- CreateTable
CREATE TABLE "PrivacyNotice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "kind" "PrivacyNoticeKind" NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" "PrivacyNoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "supersededAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PrivacyNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyNoticeText" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "noticeId" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "body" TEXT,
    "fileId" UUID,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PrivacyNoticeText_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyDpia" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "status" "PrivacyDpiaStatus" NOT NULL DEFAULT 'DRAFT',
    "fileId" UUID,
    "fileSha256" TEXT,
    "signedByName" TEXT,
    "signedOn" DATE,
    "reviewDueOn" DATE,
    "storedAt" TIMESTAMPTZ(3),
    "storedById" UUID,
    "supersededAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PrivacyDpia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingActivity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "legalBasis" TEXT NOT NULL,
    "dataSubjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "processors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "transfers" TEXT NOT NULL,
    "retention" TEXT NOT NULL,
    "security" TEXT NOT NULL,
    "status" "ProcessingActivityStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProcessingActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffNoticeAck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "noticeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "noticeSha256" TEXT NOT NULL,
    "sessionId" UUID,
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StaffNoticeAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyNotice_tenantId_companyId_kind_versionNo_key" ON "PrivacyNotice"("tenantId", "companyId", "kind", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyNotice_tenantId_companyId_kind_label_key" ON "PrivacyNotice"("tenantId", "companyId", "kind", "label");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyNotice_tenantId_id_key" ON "PrivacyNotice"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyNotice_tenantId_companyId_id_key" ON "PrivacyNotice"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyNoticeText_tenantId_noticeId_locale_key" ON "PrivacyNoticeText"("tenantId", "noticeId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyDpia_tenantId_companyId_versionNo_key" ON "PrivacyDpia"("tenantId", "companyId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyDpia_tenantId_id_key" ON "PrivacyDpia"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingActivity_tenantId_companyId_code_key" ON "ProcessingActivity"("tenantId", "companyId", "code");

-- CreateIndex
CREATE INDEX "StaffNoticeAck_tenantId_noticeId_idx" ON "StaffNoticeAck"("tenantId", "noticeId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffNoticeAck_tenantId_companyId_userId_noticeVersion_key" ON "StaffNoticeAck"("tenantId", "companyId", "userId", "noticeVersion");

-- CreateIndex
CREATE INDEX "WorkerNoticeAck_tenantId_noticeId_workerId_idx" ON "WorkerNoticeAck"("tenantId", "noticeId", "workerId");

-- AddForeignKey
ALTER TABLE "PrivacyNotice" ADD CONSTRAINT "PrivacyNotice_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrivacyNoticeText" ADD CONSTRAINT "PrivacyNoticeText_tenantId_noticeId_fkey" FOREIGN KEY ("tenantId", "noticeId") REFERENCES "PrivacyNotice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrivacyNoticeText" ADD CONSTRAINT "PrivacyNoticeText_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrivacyDpia" ADD CONSTRAINT "PrivacyDpia_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrivacyDpia" ADD CONSTRAINT "PrivacyDpia_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProcessingActivity" ADD CONSTRAINT "ProcessingActivity_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StaffNoticeAck" ADD CONSTRAINT "StaffNoticeAck_tenantId_companyId_noticeId_fkey" FOREIGN KEY ("tenantId", "companyId", "noticeId") REFERENCES "PrivacyNotice"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StaffNoticeAck" ADD CONSTRAINT "StaffNoticeAck_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerNoticeAck" ADD CONSTRAINT "WorkerNoticeAck_tenantId_noticeId_fkey" FOREIGN KEY ("tenantId", "noticeId") REFERENCES "PrivacyNotice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

