-- CreateEnum
CREATE TYPE "FileUploadStatus" AS ENUM ('OPEN', 'COMPLETED', 'ABORTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RequiredDocumentLevel" AS ENUM ('BLOCK', 'WARN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileCategory" ADD VALUE 'SUPPLIER_CERTIFICATE';
ALTER TYPE "FileCategory" ADD VALUE 'TEST_REPORT';
ALTER TYPE "FileCategory" ADD VALUE 'DECLARATION';
ALTER TYPE "FileCategory" ADD VALUE 'BODY_PHOTO';
ALTER TYPE "FileCategory" ADD VALUE 'QUESTIONNAIRE';
ALTER TYPE "FileCategory" ADD VALUE 'PROOF';
ALTER TYPE "FileCategory" ADD VALUE 'SAMPLE_PHOTO';

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "exifStrippedAt" TIMESTAMPTZ(3),
ADD COLUMN     "expiresOn" DATE,
ADD COLUMN     "expiryRemindedAt" TIMESTAMPTZ(3),
ADD COLUMN     "seriesId" UUID,
ADD COLUMN     "sourceFileId" UUID,
ADD COLUMN     "supersededAt" TIMESTAMPTZ(3),
ADD COLUMN     "thumbnailKey" TEXT,
ADD COLUMN     "versionNo" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "FileUploadSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "fileId" UUID NOT NULL,
    "uploadId" TEXT NOT NULL,
    "partSizeBytes" INTEGER NOT NULL,
    "partsDone" JSONB NOT NULL DEFAULT '[]',
    "status" "FileUploadStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FileUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileMarkup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "fileId" UUID NOT NULL,
    "page" INTEGER,
    "shapes" JSONB NOT NULL,
    "note" TEXT,
    "resultFileId" UUID,
    "createdById" UUID,
    "partyId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileMarkup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequiredDocumentRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "category" "FileCategory" NOT NULL,
    "beforeStatus" TEXT NOT NULL,
    "partyRole" "PartyRole",
    "level" "RequiredDocumentLevel" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RequiredDocumentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileUploadSession_tenantId_fileId_idx" ON "FileUploadSession"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "FileUploadSession_tenantId_uploadId_key" ON "FileUploadSession"("tenantId", "uploadId");

-- CreateIndex
CREATE INDEX "FileMarkup_tenantId_fileId_idx" ON "FileMarkup"("tenantId", "fileId");

-- CreateIndex
CREATE INDEX "FileMarkup_tenantId_partyId_idx" ON "FileMarkup"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "FileMarkup_tenantId_resultFileId_key" ON "FileMarkup"("tenantId", "resultFileId");

-- CreateIndex
CREATE INDEX "RequiredDocumentRule_tenantId_companyId_recordType_idx" ON "RequiredDocumentRule"("tenantId", "companyId", "recordType");

-- CreateIndex
CREATE INDEX "StoredFile_tenantId_sourceFileId_idx" ON "StoredFile"("tenantId", "sourceFileId");

-- CreateIndex
CREATE INDEX "StoredFile_tenantId_expiresOn_idx" ON "StoredFile"("tenantId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_tenantId_thumbnailKey_key" ON "StoredFile"("tenantId", "thumbnailKey");

-- AddForeignKey
ALTER TABLE "FileUploadSession" ADD CONSTRAINT "FileUploadSession_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileMarkup" ADD CONSTRAINT "FileMarkup_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileMarkup" ADD CONSTRAINT "FileMarkup_tenantId_resultFileId_fkey" FOREIGN KEY ("tenantId", "resultFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequiredDocumentRule" ADD CONSTRAINT "RequiredDocumentRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_tenantId_seriesId_fkey" FOREIGN KEY ("tenantId", "seriesId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_tenantId_sourceFileId_fkey" FOREIGN KEY ("tenantId", "sourceFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

