-- CreateEnum
CREATE TYPE "LinkPurpose" AS ENUM ('QUOTE_ACCEPT', 'PO_CONFIRM', 'DOCUMENT_VIEW', 'DEPOSIT_INFO');

-- CreateEnum
CREATE TYPE "LinkEvidenceAction" AS ENUM ('OPENED', 'ACCEPTED', 'DECLINED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "LinkEmailCheck" AS ENUM ('MATCHED', 'NOT_KNOWN', 'NOT_ASKED');

-- CreateTable
CREATE TABLE "OneOffLink" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "purpose" "LinkPurpose" NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT,
    "note" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "maxUses" INTEGER NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,

    CONSTRAINT "OneOffLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkEvidence" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "action" "LinkEvidenceAction" NOT NULL,
    "useNumber" INTEGER,
    "typedName" TEXT,
    "emailCheck" "LinkEmailCheck" NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT NOT NULL,

    CONSTRAINT "LinkEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OneOffLink_tokenHash_key" ON "OneOffLink"("tokenHash");

-- CreateIndex
CREATE INDEX "OneOffLink_tenantId_recordType_recordId_idx" ON "OneOffLink"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "OneOffLink_tenantId_partyId_id_key" ON "OneOffLink"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "LinkEvidence_tenantId_linkId_at_idx" ON "LinkEvidence"("tenantId", "linkId", "at");

-- AddForeignKey
ALTER TABLE "OneOffLink" ADD CONSTRAINT "OneOffLink_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LinkEvidence" ADD CONSTRAINT "LinkEvidence_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

