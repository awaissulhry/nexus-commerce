-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED');

-- CreateEnum
CREATE TYPE "FileAudience" AS ENUM ('OFFICE', 'FLOOR', 'PARTNER', 'LINK');

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "kind" "FileKind" NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storeAccountId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "visibility" "FileAudience"[] DEFAULT ARRAY['OFFICE']::"FileAudience"[],
    "floorSiteId" UUID,
    "partyId" UUID,
    "retainUntil" TIMESTAMPTZ(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "quarantineReason" TEXT,
    "availableAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoredFile_tenantId_recordType_recordId_idx" ON "StoredFile"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "StoredFile_tenantId_floorSiteId_idx" ON "StoredFile"("tenantId", "floorSiteId");

-- CreateIndex
CREATE INDEX "StoredFile_tenantId_partyId_idx" ON "StoredFile"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_tenantId_storageKey_key" ON "StoredFile"("tenantId", "storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_tenantId_id_key" ON "StoredFile"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_tenantId_companyId_floorSiteId_fkey" FOREIGN KEY ("tenantId", "companyId", "floorSiteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_tenantId_storeAccountId_fkey" FOREIGN KEY ("tenantId", "storeAccountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

