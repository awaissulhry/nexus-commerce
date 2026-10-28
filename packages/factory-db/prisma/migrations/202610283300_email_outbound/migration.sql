-- CreateEnum
CREATE TYPE "EmailIdentityKind" AS ENUM ('CONVERSATION', 'NOTIFICATION');

-- CreateEnum
CREATE TYPE "EmailDisplayNamePolicy" AS ENUM ('COMPANY', 'PERSON_VIA_COMPANY', 'PERSON_ADDRESS');

-- CreateEnum
CREATE TYPE "EmailVerificationStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE');

-- CreateEnum
CREATE TYPE "EmailIdentityStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "EmailOutboundStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('BOUNCE', 'COMPLAINT', 'MANUAL');

-- CreateTable
CREATE TABLE "EmailIdentity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "kind" "EmailIdentityKind" NOT NULL,
    "domain" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayNamePolicy" "EmailDisplayNamePolicy" NOT NULL DEFAULT 'PERSON_VIA_COMPANY',
    "replyDomain" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "sesIdentityArn" TEXT,
    "verificationStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "dkimStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "dkimTokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastCheckedAt" TIMESTAMPTZ(3),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "EmailIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "EmailIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOutbound" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "threadId" UUID,
    "messageId" UUID,
    "recordType" TEXT,
    "recordId" UUID,
    "templateKey" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "to" TEXT[],
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "referenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sesMessageId" TEXT,
    "status" "EmailOutboundStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedUntil" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "queuedAt" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "bouncedAt" TIMESTAMPTZ(3),
    "complainedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "EmailOutbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "address" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "detail" TEXT,
    "outboundId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailIdentity_tenantId_companyId_kind_idx" ON "EmailIdentity"("tenantId", "companyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "EmailIdentity_tenantId_companyId_fromAddress_key" ON "EmailIdentity"("tenantId", "companyId", "fromAddress");

-- CreateIndex
CREATE UNIQUE INDEX "EmailIdentity_tenantId_id_key" ON "EmailIdentity"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EmailIdentity_tenantId_companyId_id_key" ON "EmailIdentity"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "EmailOutbound_tenantId_threadId_queuedAt_idx" ON "EmailOutbound"("tenantId", "threadId", "queuedAt");

-- CreateIndex
CREATE INDEX "EmailOutbound_tenantId_status_queuedAt_idx" ON "EmailOutbound"("tenantId", "status", "queuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbound_tenantId_emailMessageId_key" ON "EmailOutbound"("tenantId", "emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbound_tenantId_sesMessageId_key" ON "EmailOutbound"("tenantId", "sesMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_tenantId_address_key" ON "Suppression"("tenantId", "address");

-- AddForeignKey
ALTER TABLE "EmailIdentity" ADD CONSTRAINT "EmailIdentity_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmailIdentity" ADD CONSTRAINT "EmailIdentity_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmailOutbound" ADD CONSTRAINT "EmailOutbound_tenantId_companyId_identityId_fkey" FOREIGN KEY ("tenantId", "companyId", "identityId") REFERENCES "EmailIdentity"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmailOutbound" ADD CONSTRAINT "EmailOutbound_tenantId_threadId_fkey" FOREIGN KEY ("tenantId", "threadId") REFERENCES "Thread"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

