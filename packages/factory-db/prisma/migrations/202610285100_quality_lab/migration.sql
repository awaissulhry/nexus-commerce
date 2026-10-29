-- CreateEnum
CREATE TYPE "CrViEvidenceRule" AS ENUM ('SUPPLIER_REPORT_ACCEPTED', 'LOT_REPORT_REQUIRED');

-- CreateEnum
CREATE TYPE "LabTest" AS ENUM ('CR_VI');

-- CreateEnum
CREATE TYPE "LabVerdict" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "LotDocumentKind" AS ENUM ('PPE_CERTIFICATE', 'CR_VI_STATEMENT', 'LWG_CERTIFICATE', 'FABRIC_TEST', 'OTHER');

-- CreateEnum
CREATE TYPE "LotDocumentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "QualitySettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "crViEvidenceRule" "CrViEvidenceRule" NOT NULL DEFAULT 'SUPPLIER_REPORT_ACCEPTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QualitySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "test" "LabTest" NOT NULL,
    "method" TEXT NOT NULL,
    "valueMgKg" DECIMAL(8,3),
    "belowDetectionLimit" BOOLEAN NOT NULL DEFAULT false,
    "detectionLimitMgKg" DECIMAL(8,3),
    "unit" TEXT NOT NULL,
    "limitMgKg" DECIMAL(8,3) NOT NULL,
    "verdict" "LabVerdict" NOT NULL,
    "lab" TEXT NOT NULL,
    "reportNumber" TEXT,
    "testedOn" DATE NOT NULL,
    "evidence" "CrViEvidence" NOT NULL,
    "article" TEXT,
    "periodFrom" DATE,
    "periodTo" DATE,
    "fileId" UUID NOT NULL,
    "supersedesId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LabResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "kind" "LotDocumentKind" NOT NULL,
    "fileId" UUID NOT NULL,
    "validTo" DATE,
    "status" "LotDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LotDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualitySettings_tenantId_companyId_idx" ON "QualitySettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "LabResult_tenantId_lotId_createdAt_idx" ON "LabResult"("tenantId", "lotId", "createdAt");

-- CreateIndex
CREATE INDEX "LabResult_tenantId_fileId_idx" ON "LabResult"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "LabResult_tenantId_lotId_id_key" ON "LabResult"("tenantId", "lotId", "id");

-- CreateIndex
CREATE INDEX "LotDocument_tenantId_lotId_idx" ON "LotDocument"("tenantId", "lotId");

-- CreateIndex
CREATE INDEX "LotDocument_tenantId_fileId_idx" ON "LotDocument"("tenantId", "fileId");

-- AddForeignKey
ALTER TABLE "QualitySettings" ADD CONSTRAINT "QualitySettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_tenantId_lotId_supersedesId_fkey" FOREIGN KEY ("tenantId", "lotId", "supersedesId") REFERENCES "LabResult"("tenantId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LotDocument" ADD CONSTRAINT "LotDocument_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LotDocument" ADD CONSTRAINT "LotDocument_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LotDocument" ADD CONSTRAINT "LotDocument_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

