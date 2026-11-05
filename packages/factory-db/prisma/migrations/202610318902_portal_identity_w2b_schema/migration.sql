-- CreateEnum
CREATE TYPE "UserAudience" AS ENUM ('OFFICE', 'PARTNER');

-- CreateEnum
CREATE TYPE "PartnerKind" AS ENUM ('CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR', 'GUEST');

-- CreateEnum
CREATE TYPE "PortalSignInCodePurpose" AS ENUM ('SIGN_IN', 'STEP_UP');

-- AlterEnum
ALTER TYPE "PrivacyNoticeKind" ADD VALUE 'PORTAL_TERMS';

-- AlterEnum
ALTER TYPE "RoleAudience" ADD VALUE 'PARTNER';

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "accessUntil" TIMESTAMPTZ(3),
ADD COLUMN     "audience" "UserAudience" NOT NULL DEFAULT 'OFFICE',
ADD COLUMN     "partnerRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "partyId" UUID;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "audience" "UserAudience" NOT NULL DEFAULT 'OFFICE',
ADD COLUMN     "partyId" UUID,
ADD COLUMN     "previewById" UUID,
ADD COLUMN     "previewOfPartyId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accessUntil" TIMESTAMPTZ(3),
ADD COLUMN     "audience" "UserAudience" NOT NULL DEFAULT 'OFFICE',
ADD COLUMN     "partnerKind" "PartnerKind",
ADD COLUMN     "partyId" UUID;

-- CreateTable
CREATE TABLE "PortalSignInCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "purpose" "PortalSignInCodePurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "linkTokenHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "ipHash" TEXT,

    CONSTRAINT "PortalSignInCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "portalOn" BOOLEAN NOT NULL DEFAULT false,
    "progressShared" BOOLEAN NOT NULL DEFAULT false,
    "maxUsers" INTEGER,
    "allowedRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PortalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyBranding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "logoFileId" UUID,
    "logoDarkFileId" UUID,
    "accentColour" TEXT,
    "senderDisplayName" TEXT,
    "portalLabel" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CompanyBranding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerNoticeAck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "noticeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "noticeSha256" TEXT NOT NULL,
    "sessionId" UUID,
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartnerNoticeAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalSignInCode_linkTokenHash_key" ON "PortalSignInCode"("linkTokenHash");

-- CreateIndex
CREATE INDEX "PortalSignInCode_tenantId_userId_idx" ON "PortalSignInCode"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "PortalSettings_tenantId_partyId_idx" ON "PortalSettings"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "CompanyBranding_tenantId_companyId_idx" ON "CompanyBranding"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "PartnerNoticeAck_tenantId_noticeId_idx" ON "PartnerNoticeAck"("tenantId", "noticeId");

-- CreateIndex
CREATE INDEX "PartnerNoticeAck_tenantId_partyId_idx" ON "PartnerNoticeAck"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerNoticeAck_tenantId_companyId_userId_noticeVersion_key" ON "PartnerNoticeAck"("tenantId", "companyId", "userId", "noticeVersion");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_partyId_idx" ON "Invitation"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "Session_tenantId_partyId_idx" ON "Session"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "User_tenantId_partyId_idx" ON "User"("tenantId", "partyId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_previewOfPartyId_fkey" FOREIGN KEY ("tenantId", "previewOfPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_previewById_fkey" FOREIGN KEY ("tenantId", "previewById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalSignInCode" ADD CONSTRAINT "PortalSignInCode_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalSettings" ADD CONSTRAINT "PortalSettings_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CompanyBranding" ADD CONSTRAINT "CompanyBranding_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CompanyBranding" ADD CONSTRAINT "CompanyBranding_tenantId_logoFileId_fkey" FOREIGN KEY ("tenantId", "logoFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CompanyBranding" ADD CONSTRAINT "CompanyBranding_tenantId_logoDarkFileId_fkey" FOREIGN KEY ("tenantId", "logoDarkFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartnerNoticeAck" ADD CONSTRAINT "PartnerNoticeAck_tenantId_companyId_noticeId_fkey" FOREIGN KEY ("tenantId", "companyId", "noticeId") REFERENCES "PrivacyNotice"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartnerNoticeAck" ADD CONSTRAINT "PartnerNoticeAck_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartnerNoticeAck" ADD CONSTRAINT "PartnerNoticeAck_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

