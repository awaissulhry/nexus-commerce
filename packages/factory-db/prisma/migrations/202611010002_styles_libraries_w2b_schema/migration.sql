-- CreateEnum
CREATE TYPE "StyleImageKind" AS ENUM ('SKETCH', 'PHOTO', 'PAGE');

-- CreateEnum
CREATE TYPE "PatternFileKind" AS ENUM ('PATTERN', 'MARKER', 'CAD', 'OTHER');

-- CreateEnum
CREATE TYPE "PatternFileFormat" AS ENUM ('DXF_AAMA', 'LECTRA', 'GERBER', 'PDF');

-- CreateEnum
CREATE TYPE "StyleLifecycle" AS ENUM ('CONCEPT', 'DEVELOPMENT', 'SAMPLING', 'APPROVED', 'IN_PRODUCTION', 'PHASE_OUT', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "ProductEditRule" AS ENUM ('FREE', 'NEW_REVISION', 'CHANGE_ORDER', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ConsumptionTolerance" AS ENUM ('MATCH', 'MAY_DIFFER', 'WARN_ABOVE');

-- CreateEnum
CREATE TYPE "ColourSystem" AS ENUM ('PANTONE', 'RAL', 'NCS', 'OWN');

-- CreateEnum
CREATE TYPE "MaterialApproval" AS ENUM ('PENDING', 'APPROVED', 'CONDITIONAL', 'BLOCKED');

-- AlterTable
ALTER TABLE "Colour" ADD COLUMN     "family" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "system" "ColourSystem";

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "approval" "MaterialApproval" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMPTZ(3),
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "properties" JSONB;

-- AlterTable
ALTER TABLE "Style" ADD COLUMN     "lifecycle" "StyleLifecycle" NOT NULL DEFAULT 'CONCEPT',
ADD COLUMN     "lifecycleChangedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lifecycleChangedById" UUID,
ADD COLUMN     "productTypeProfileId" UUID,
ADD COLUMN     "replacedById" UUID,
ADD COLUMN     "soldUnderOurName" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StyleText" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortDescription" TEXT,
    "longDescription" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleText_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleImage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID,
    "colourwayId" UUID,
    "fileId" UUID NOT NULL,
    "kind" "StyleImageKind" NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "caption" TEXT,
    "callouts" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleRevisionFile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "kind" "PatternFileKind" NOT NULL,
    "format" "PatternFileFormat",
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleRevisionFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTypeProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "productType" "ProductType" NOT NULL,
    "parentId" UUID,
    "requiredAttributes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultSizeScaleId" UUID,
    "labelTemplateId" UUID,
    "measurementTemplateId" UUID,
    "defaultPpeCategory" "PpeCategory",
    "defaultPpeStandard" TEXT,
    "defaultPpeClass" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductTypeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GtinRange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gs1Prefix" TEXT NOT NULL,
    "firstReference" INTEGER NOT NULL,
    "lastReference" INTEGER NOT NULL,
    "nextReference" INTEGER NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GtinRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandingSet" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "labelArtworkFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "brandColourIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "packagingRules" JSONB,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BrandingSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "editRuleConcept" "ProductEditRule",
    "editRuleDevelopment" "ProductEditRule",
    "editRuleSampling" "ProductEditRule",
    "editRuleApproved" "ProductEditRule",
    "editRuleInProduction" "ProductEditRule",
    "editRulePhaseOut" "ProductEditRule",
    "editRuleDiscontinued" "ProductEditRule",
    "consumptionTolerance" "ConsumptionTolerance",
    "consumptionTolerancePct" DECIMAL(7,4),
    "consumptionToleranceByKind" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StyleText_tenantId_styleId_language_key" ON "StyleText"("tenantId", "styleId", "language");

-- CreateIndex
CREATE INDEX "StyleImage_tenantId_styleId_idx" ON "StyleImage"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "StyleImage_tenantId_fileId_idx" ON "StyleImage"("tenantId", "fileId");

-- CreateIndex
CREATE INDEX "StyleRevisionFile_tenantId_revisionId_idx" ON "StyleRevisionFile"("tenantId", "revisionId");

-- CreateIndex
CREATE INDEX "StyleRevisionFile_tenantId_fileId_idx" ON "StyleRevisionFile"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTypeProfile_tenantId_code_key" ON "ProductTypeProfile"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTypeProfile_tenantId_id_key" ON "ProductTypeProfile"("tenantId", "id");

-- CreateIndex
CREATE INDEX "GtinRange_tenantId_companyId_idx" ON "GtinRange"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "BrandingSet_tenantId_partyId_idx" ON "BrandingSet"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandingSet_tenantId_code_key" ON "BrandingSet"("tenantId", "code");

-- CreateIndex
CREATE INDEX "ProductSettings_tenantId_companyId_idx" ON "ProductSettings"("tenantId", "companyId");

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_replacedById_fkey" FOREIGN KEY ("tenantId", "replacedById") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_productTypeProfileId_fkey" FOREIGN KEY ("tenantId", "productTypeProfileId") REFERENCES "ProductTypeProfile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleText" ADD CONSTRAINT "StyleText_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleImage" ADD CONSTRAINT "StyleImage_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleImage" ADD CONSTRAINT "StyleImage_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleImage" ADD CONSTRAINT "StyleImage_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleImage" ADD CONSTRAINT "StyleImage_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRevisionFile" ADD CONSTRAINT "StyleRevisionFile_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRevisionFile" ADD CONSTRAINT "StyleRevisionFile_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductTypeProfile" ADD CONSTRAINT "ProductTypeProfile_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductTypeProfile" ADD CONSTRAINT "ProductTypeProfile_tenantId_parentId_fkey" FOREIGN KEY ("tenantId", "parentId") REFERENCES "ProductTypeProfile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductTypeProfile" ADD CONSTRAINT "ProductTypeProfile_tenantId_defaultSizeScaleId_fkey" FOREIGN KEY ("tenantId", "defaultSizeScaleId") REFERENCES "SizeScale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductTypeProfile" ADD CONSTRAINT "ProductTypeProfile_tenantId_labelTemplateId_fkey" FOREIGN KEY ("tenantId", "labelTemplateId") REFERENCES "LabelTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductTypeProfile" ADD CONSTRAINT "ProductTypeProfile_tenantId_measurementTemplateId_fkey" FOREIGN KEY ("tenantId", "measurementTemplateId") REFERENCES "MeasurementTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GtinRange" ADD CONSTRAINT "GtinRange_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BrandingSet" ADD CONSTRAINT "BrandingSet_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BrandingSet" ADD CONSTRAINT "BrandingSet_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSettings" ADD CONSTRAINT "ProductSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

