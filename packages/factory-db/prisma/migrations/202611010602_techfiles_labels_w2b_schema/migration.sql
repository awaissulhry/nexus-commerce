-- CreateEnum
CREATE TYPE "LabelTemplateKind" AS ENUM ('PPE_GARMENT', 'GLOVE_MARKING', 'FIBRE_CARE', 'PACKAGING');

-- CreateEnum
CREATE TYPE "LabelQrTarget" AS ENUM ('NONE', 'BATCH_DOC', 'STYLE_DOC');

-- CreateEnum
CREATE TYPE "ComplianceDocumentOrigin" AS ENUM ('SIGNED', 'GENERATED');

-- CreateEnum
CREATE TYPE "ComplianceTranslationStatus" AS ENUM ('DRAFT', 'IN_TRANSLATION', 'CHECKED');

-- CreateEnum
CREATE TYPE "TechnicalFileStatus" AS ENUM ('OPEN', 'COMPLETE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AnnexIIIPoint" AS ENUM ('A_DESCRIPTION', 'B_RISK_ASSESSMENT', 'C_REQUIREMENTS', 'D_DRAWINGS', 'E_EXPLANATIONS', 'F_STANDARDS', 'G_OTHER_SPECIFICATIONS', 'H_CALCULATIONS', 'I_TEST_REPORTS', 'J_PRODUCTION_CONTROL', 'K_USER_INFORMATION', 'L_SINGLE_UNIT', 'M_SERIES_FITTED');

-- CreateEnum
CREATE TYPE "TechnicalFileItemState" AS ENUM ('MISSING', 'LINKED', 'REVIEWED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ProductRiskAssessmentStatus" AS ENUM ('DRAFT', 'SIGNED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ProductHazard" AS ENUM ('ABRASION', 'IMPACT', 'TEAR', 'SEAM_BURST', 'CUT', 'CHEMICAL', 'THERMAL', 'VISIBILITY', 'ERGONOMIC', 'OTHER');

-- CreateEnum
CREATE TYPE "ResidualRisk" AS ENUM ('NEGLIGIBLE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ProductionControlTestKind" AS ENUM ('SEAM_STRENGTH', 'POCKET_RETENTION', 'LABEL_DURABILITY', 'ABRASION', 'TEAR_STRENGTH', 'IMPACT', 'DIMENSIONS', 'COLOUR_FASTNESS', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductionControlFrequency" AS ENUM ('EVERY_BATCH', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ON_CHANGE', 'ONCE');

-- CreateEnum
CREATE TYPE "ControlTestResult" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "EvidencePackPurpose" AS ENUM ('AUTHORITY', 'CUSTOMER', 'SHIPMENT');

-- CreateEnum
CREATE TYPE "EvidencePackStatus" AS ENUM ('BUILDING', 'BUILT', 'FAILED');

-- CreateEnum
CREATE TYPE "LabelArtworkStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "GarmentLabelSpoilKind" AS ENUM ('SPOILED', 'RETURNED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'COMPLIANCE_PACK';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'EVIDENCE_PACK';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'TECH_PACK';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'USER_INFORMATION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'TECHNICAL_FILE';
ALTER TYPE "NumberKind" ADD VALUE 'EVIDENCE_PACK';

-- DropIndex
DROP INDEX "ComplianceDocument_tenantId_styleId_kind_language_revision_key";

-- AlterTable
ALTER TABLE "ComplianceDocument" ADD COLUMN     "content" JSONB,
ADD COLUMN     "marketCode" TEXT,
ADD COLUMN     "origin" "ComplianceDocumentOrigin" NOT NULL DEFAULT 'SIGNED',
ADD COLUMN     "sections" JSONB,
ADD COLUMN     "translationCheckedAt" TIMESTAMPTZ(3),
ADD COLUMN     "translationCheckedById" UUID,
ADD COLUMN     "translationOfId" UUID,
ADD COLUMN     "translationStatus" "ComplianceTranslationStatus";

-- AlterTable
ALTER TABLE "LabelTemplate" ADD COLUMN     "gpsrContact" TEXT,
ADD COLUMN     "kind" "LabelTemplateKind" NOT NULL DEFAULT 'PPE_GARMENT',
ADD COLUMN     "originClaimKey" TEXT,
ADD COLUMN     "qrTarget" "LabelQrTarget" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "ComplianceDocumentBatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "styleId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "siteId" UUID,
    "workOrderId" UUID,
    "batchNumber" TEXT NOT NULL,
    "shipmentId" UUID,
    "retainUntil" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ComplianceDocumentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicalFile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "styleId" UUID NOT NULL,
    "certificateId" UUID,
    "status" "TechnicalFileStatus" NOT NULL DEFAULT 'OPEN',
    "keeperId" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "completedById" UUID,
    "archivedAt" TIMESTAMPTZ(3),
    "archivedById" UUID,
    "archiveReason" TEXT,
    "retainUntil" DATE,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TechnicalFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicalFileItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "technicalFileId" UUID NOT NULL,
    "point" "AnnexIIIPoint" NOT NULL,
    "seq" INTEGER NOT NULL,
    "state" "TechnicalFileItemState" NOT NULL DEFAULT 'MISSING',
    "recordType" TEXT,
    "recordId" UUID,
    "fileId" UUID,
    "note" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TechnicalFileItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRiskAssessment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "technicalFileId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "ProductRiskAssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "classReasoning" TEXT,
    "signedAt" TIMESTAMPTZ(3),
    "signedById" UUID,
    "signedByName" TEXT,
    "signedByFunction" TEXT,
    "supersededAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductRiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRiskRow" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "assessmentId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "hazard" "ProductHazard" NOT NULL,
    "hazardNote" TEXT,
    "garmentZone" TEXT,
    "intendedUse" TEXT NOT NULL,
    "foreseeableMisuse" TEXT,
    "control" TEXT NOT NULL,
    "standardClause" TEXT,
    "standardId" UUID,
    "residualRisk" "ResidualRisk" NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductRiskRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionControlTest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "styleId" UUID NOT NULL,
    "siteId" UUID,
    "workOrderId" UUID,
    "batchNumber" TEXT,
    "test" "ProductionControlTestKind" NOT NULL,
    "testName" TEXT,
    "standardClause" TEXT,
    "frequency" "ProductionControlFrequency" NOT NULL,
    "dueOn" DATE NOT NULL,
    "sample" TEXT,
    "result" "ControlTestResult",
    "testedOn" DATE,
    "testedBy" TEXT,
    "labReportFileId" UUID,
    "reportNumber" TEXT,
    "resultNote" TEXT,
    "retainUntil" DATE,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductionControlTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidencePack" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "purpose" "EvidencePackPurpose" NOT NULL,
    "technicalFileId" UUID,
    "shipmentId" UUID,
    "scope" JSONB NOT NULL,
    "language" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipientPartyId" UUID,
    "status" "EvidencePackStatus" NOT NULL DEFAULT 'BUILDING',
    "contents" JSONB,
    "fingerprint" TEXT,
    "fileId" UUID,
    "zipFileId" UUID,
    "failureReason" TEXT,
    "builtAt" TIMESTAMPTZ(3),
    "retainUntil" DATE,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "EvidencePack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelArtworkVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "templateId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "fileId" UUID NOT NULL,
    "status" "LabelArtworkStatus" NOT NULL DEFAULT 'DRAFT',
    "authorId" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "retiredAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LabelArtworkVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GarmentLabelSpoil" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "printId" UUID NOT NULL,
    "kind" "GarmentLabelSpoilKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GarmentLabelSpoil_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceDocumentBatch_tenantId_batchNumber_idx" ON "ComplianceDocumentBatch"("tenantId", "batchNumber");

-- CreateIndex
CREATE INDEX "ComplianceDocumentBatch_tenantId_shipmentId_idx" ON "ComplianceDocumentBatch"("tenantId", "shipmentId");

-- CreateIndex
CREATE INDEX "ComplianceDocumentBatch_tenantId_workOrderId_idx" ON "ComplianceDocumentBatch"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceDocumentBatch_tenantId_documentId_batchNumber_shi_key" ON "ComplianceDocumentBatch"("tenantId", "documentId", "batchNumber", "shipmentId");

-- CreateIndex
CREATE INDEX "TechnicalFile_tenantId_styleId_idx" ON "TechnicalFile"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalFile_tenantId_companyId_number_key" ON "TechnicalFile"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalFile_tenantId_id_key" ON "TechnicalFile"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TechnicalFileItem_tenantId_recordType_recordId_idx" ON "TechnicalFileItem"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "TechnicalFileItem_tenantId_fileId_idx" ON "TechnicalFileItem"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalFileItem_tenantId_technicalFileId_point_seq_key" ON "TechnicalFileItem"("tenantId", "technicalFileId", "point", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRiskAssessment_tenantId_technicalFileId_revision_key" ON "ProductRiskAssessment"("tenantId", "technicalFileId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRiskAssessment_tenantId_id_key" ON "ProductRiskAssessment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRiskRow_tenantId_assessmentId_seq_key" ON "ProductRiskRow"("tenantId", "assessmentId", "seq");

-- CreateIndex
CREATE INDEX "ProductionControlTest_tenantId_styleId_dueOn_idx" ON "ProductionControlTest"("tenantId", "styleId", "dueOn");

-- CreateIndex
CREATE INDEX "ProductionControlTest_tenantId_workOrderId_idx" ON "ProductionControlTest"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "EvidencePack_tenantId_technicalFileId_idx" ON "EvidencePack"("tenantId", "technicalFileId");

-- CreateIndex
CREATE INDEX "EvidencePack_tenantId_shipmentId_idx" ON "EvidencePack"("tenantId", "shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidencePack_tenantId_companyId_number_key" ON "EvidencePack"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "LabelArtworkVersion_tenantId_templateId_versionNo_key" ON "LabelArtworkVersion"("tenantId", "templateId", "versionNo");

-- CreateIndex
CREATE INDEX "GarmentLabelSpoil_tenantId_workOrderId_idx" ON "GarmentLabelSpoil"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "GarmentLabelSpoil_tenantId_printId_idx" ON "GarmentLabelSpoil"("tenantId", "printId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceDocument_tenantId_styleId_kind_language_revision__key" ON "ComplianceDocument"("tenantId", "styleId", "kind", "language", "revision", "origin");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceDocument_tenantId_styleId_id_key" ON "ComplianceDocument"("tenantId", "styleId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GarmentLabelPrint_tenantId_siteId_workOrderId_id_key" ON "GarmentLabelPrint"("tenantId", "siteId", "workOrderId", "id");

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_tenantId_styleId_translationOfId_fkey" FOREIGN KEY ("tenantId", "styleId", "translationOfId") REFERENCES "ComplianceDocument"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocumentBatch" ADD CONSTRAINT "ComplianceDocumentBatch_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocumentBatch" ADD CONSTRAINT "ComplianceDocumentBatch_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocumentBatch" ADD CONSTRAINT "ComplianceDocumentBatch_tenantId_styleId_documentId_fkey" FOREIGN KEY ("tenantId", "styleId", "documentId") REFERENCES "ComplianceDocument"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocumentBatch" ADD CONSTRAINT "ComplianceDocumentBatch_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocumentBatch" ADD CONSTRAINT "ComplianceDocumentBatch_tenantId_siteId_styleId_workOrderI_fkey" FOREIGN KEY ("tenantId", "siteId", "styleId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TechnicalFile" ADD CONSTRAINT "TechnicalFile_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TechnicalFile" ADD CONSTRAINT "TechnicalFile_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TechnicalFile" ADD CONSTRAINT "TechnicalFile_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TechnicalFileItem" ADD CONSTRAINT "TechnicalFileItem_tenantId_technicalFileId_fkey" FOREIGN KEY ("tenantId", "technicalFileId") REFERENCES "TechnicalFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TechnicalFileItem" ADD CONSTRAINT "TechnicalFileItem_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductRiskAssessment" ADD CONSTRAINT "ProductRiskAssessment_tenantId_technicalFileId_fkey" FOREIGN KEY ("tenantId", "technicalFileId") REFERENCES "TechnicalFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductRiskRow" ADD CONSTRAINT "ProductRiskRow_tenantId_assessmentId_fkey" FOREIGN KEY ("tenantId", "assessmentId") REFERENCES "ProductRiskAssessment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductRiskRow" ADD CONSTRAINT "ProductRiskRow_tenantId_standardId_fkey" FOREIGN KEY ("tenantId", "standardId") REFERENCES "RegulationOrStandard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductionControlTest" ADD CONSTRAINT "ProductionControlTest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductionControlTest" ADD CONSTRAINT "ProductionControlTest_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductionControlTest" ADD CONSTRAINT "ProductionControlTest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductionControlTest" ADD CONSTRAINT "ProductionControlTest_tenantId_siteId_styleId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "styleId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductionControlTest" ADD CONSTRAINT "ProductionControlTest_tenantId_labReportFileId_fkey" FOREIGN KEY ("tenantId", "labReportFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_tenantId_technicalFileId_fkey" FOREIGN KEY ("tenantId", "technicalFileId") REFERENCES "TechnicalFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_tenantId_recipientPartyId_fkey" FOREIGN KEY ("tenantId", "recipientPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_tenantId_zipFileId_fkey" FOREIGN KEY ("tenantId", "zipFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabelArtworkVersion" ADD CONSTRAINT "LabelArtworkVersion_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "LabelTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabelArtworkVersion" ADD CONSTRAINT "LabelArtworkVersion_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentLabelSpoil" ADD CONSTRAINT "GarmentLabelSpoil_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentLabelSpoil" ADD CONSTRAINT "GarmentLabelSpoil_tenantId_siteId_workOrderId_printId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "printId") REFERENCES "GarmentLabelPrint"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

