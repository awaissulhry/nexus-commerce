-- CreateEnum
CREATE TYPE "PointOfMeasureKind" AS ENUM ('BODY', 'GARMENT');

-- CreateEnum
CREATE TYPE "BodyZone" AS ENUM ('UPPER', 'ARMS', 'LEGS', 'RIDING', 'OTHER');

-- CreateEnum
CREATE TYPE "MeasurementSpecStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MeasurementValueSource" AS ENUM ('TYPED', 'GRADED');

-- CreateEnum
CREATE TYPE "GradeIncrementFormat" AS ENUM ('RELATIVE', 'ABSOLUTE');

-- CreateEnum
CREATE TYPE "ProtectorPocket" AS ENUM ('SHOULDER', 'ELBOW', 'BACK', 'CHEST', 'HIP', 'KNEE');

-- CreateEnum
CREATE TYPE "MeasurementRuleKind" AS ENUM ('ORDER', 'RATIO', 'RANGE');

-- CreateEnum
CREATE TYPE "MeasurementRuleSeverity" AS ENUM ('BLOCK', 'WARN');

-- AlterTable
ALTER TABLE "BomLine" ADD COLUMN     "mtmScaleFactor" DECIMAL(7,4),
ADD COLUMN     "mtmScalePointId" UUID;

-- AlterTable
ALTER TABLE "MeasurementPoint" ADD COLUMN     "alterationMinus" DECIMAL(8,2),
ADD COLUMN     "alterationPlus" DECIMAL(8,2),
ADD COLUMN     "pointOfMeasureId" UUID,
ADD COLUMN     "tolerance" DECIMAL(8,2);

-- AlterTable
ALTER TABLE "MeasurementTemplate" ADD COLUMN     "baseSizeRule" JSONB,
ADD COLUMN     "rulesOn" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Size" ADD COLUMN     "fitCode" TEXT;

-- AlterTable
ALTER TABLE "SizeScale" ADD COLUMN     "dimensions" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "PointOfMeasure" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "description" TEXT,
    "howTo" TEXT,
    "howToI18n" JSONB,
    "pictureFileId" UUID,
    "kind" "PointOfMeasureKind" NOT NULL,
    "bodyZone" "BodyZone" NOT NULL,
    "uom" "Uom" NOT NULL DEFAULT 'CM',
    "defaultTolerance" DECIMAL(8,2),
    "bodyPointId" UUID,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PointOfMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementSpec" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "baseSize" TEXT NOT NULL,
    "status" "MeasurementSpecStatus" NOT NULL DEFAULT 'DRAFT',
    "gradeRuleId" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MeasurementSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementSpecValue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "revisionId" UUID NOT NULL,
    "specId" UUID NOT NULL,
    "pointOfMeasureId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "nominal" DECIMAL(8,2) NOT NULL,
    "toleranceMinus" DECIMAL(8,2) NOT NULL,
    "tolerancePlus" DECIMAL(8,2) NOT NULL,
    "source" "MeasurementValueSource" NOT NULL DEFAULT 'TYPED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MeasurementSpecValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sizeScaleId" UUID NOT NULL,
    "baseSize" TEXT NOT NULL,
    "format" "GradeIncrementFormat" NOT NULL DEFAULT 'RELATIVE',
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GradeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeRuleStep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "ruleId" UUID NOT NULL,
    "pointOfMeasureId" UUID NOT NULL,
    "fromSize" TEXT,
    "toSize" TEXT,
    "increment" DECIMAL(8,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GradeRuleStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prepack" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "sizeScaleId" UUID NOT NULL,
    "styleId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Prepack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrepackLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "prepackId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "styleId" UUID,
    "colourwayId" UUID,
    "quantity" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PrepackLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectorPlacement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "pocket" "ProtectorPocket" NOT NULL,
    "protectorItemId" UUID NOT NULL,
    "standard" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "positionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProtectorPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "templateId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "MeasurementRuleKind" NOT NULL,
    "pointId" UUID NOT NULL,
    "otherPointId" UUID,
    "minFactor" DECIMAL(8,4),
    "maxFactor" DECIMAL(8,4),
    "minValue" DECIMAL(8,2),
    "maxValue" DECIMAL(8,2),
    "severity" "MeasurementRuleSeverity" NOT NULL,
    "messageI18n" JSONB NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MeasurementRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PointOfMeasure_tenantId_code_key" ON "PointOfMeasure"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PointOfMeasure_tenantId_id_key" ON "PointOfMeasure"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MeasurementSpec_tenantId_styleId_idx" ON "MeasurementSpec"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementSpec_tenantId_revisionId_id_key" ON "MeasurementSpec"("tenantId", "revisionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementSpecValue_tenantId_specId_pointOfMeasureId_size_key" ON "MeasurementSpecValue"("tenantId", "specId", "pointOfMeasureId", "size");

-- CreateIndex
CREATE UNIQUE INDEX "GradeRule_tenantId_code_key" ON "GradeRule"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GradeRule_tenantId_id_key" ON "GradeRule"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GradeRuleStep_tenantId_ruleId_pointOfMeasureId_fromSize_toS_key" ON "GradeRuleStep"("tenantId", "ruleId", "pointOfMeasureId", "fromSize", "toSize");

-- CreateIndex
CREATE UNIQUE INDEX "Prepack_tenantId_sizeScaleId_code_key" ON "Prepack"("tenantId", "sizeScaleId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Prepack_tenantId_id_key" ON "Prepack"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrepackLine_tenantId_prepackId_size_colourwayId_key" ON "PrepackLine"("tenantId", "prepackId", "size", "colourwayId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectorPlacement_tenantId_revisionId_seq_key" ON "ProtectorPlacement"("tenantId", "revisionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementRule_tenantId_templateId_code_key" ON "MeasurementRule"("tenantId", "templateId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementPoint_tenantId_templateId_id_key" ON "MeasurementPoint"("tenantId", "templateId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementPoint_tenantId_id_key" ON "MeasurementPoint"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_mtmScalePointId_fkey" FOREIGN KEY ("tenantId", "mtmScalePointId") REFERENCES "MeasurementPoint"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementPoint" ADD CONSTRAINT "MeasurementPoint_tenantId_pointOfMeasureId_fkey" FOREIGN KEY ("tenantId", "pointOfMeasureId") REFERENCES "PointOfMeasure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PointOfMeasure" ADD CONSTRAINT "PointOfMeasure_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PointOfMeasure" ADD CONSTRAINT "PointOfMeasure_tenantId_pictureFileId_fkey" FOREIGN KEY ("tenantId", "pictureFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PointOfMeasure" ADD CONSTRAINT "PointOfMeasure_tenantId_bodyPointId_fkey" FOREIGN KEY ("tenantId", "bodyPointId") REFERENCES "PointOfMeasure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementSpec" ADD CONSTRAINT "MeasurementSpec_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementSpec" ADD CONSTRAINT "MeasurementSpec_tenantId_gradeRuleId_fkey" FOREIGN KEY ("tenantId", "gradeRuleId") REFERENCES "GradeRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementSpecValue" ADD CONSTRAINT "MeasurementSpecValue_tenantId_revisionId_specId_fkey" FOREIGN KEY ("tenantId", "revisionId", "specId") REFERENCES "MeasurementSpec"("tenantId", "revisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementSpecValue" ADD CONSTRAINT "MeasurementSpecValue_tenantId_pointOfMeasureId_fkey" FOREIGN KEY ("tenantId", "pointOfMeasureId") REFERENCES "PointOfMeasure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GradeRule" ADD CONSTRAINT "GradeRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GradeRule" ADD CONSTRAINT "GradeRule_tenantId_sizeScaleId_fkey" FOREIGN KEY ("tenantId", "sizeScaleId") REFERENCES "SizeScale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GradeRuleStep" ADD CONSTRAINT "GradeRuleStep_tenantId_ruleId_fkey" FOREIGN KEY ("tenantId", "ruleId") REFERENCES "GradeRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GradeRuleStep" ADD CONSTRAINT "GradeRuleStep_tenantId_pointOfMeasureId_fkey" FOREIGN KEY ("tenantId", "pointOfMeasureId") REFERENCES "PointOfMeasure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Prepack" ADD CONSTRAINT "Prepack_tenantId_sizeScaleId_fkey" FOREIGN KEY ("tenantId", "sizeScaleId") REFERENCES "SizeScale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Prepack" ADD CONSTRAINT "Prepack_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrepackLine" ADD CONSTRAINT "PrepackLine_tenantId_prepackId_fkey" FOREIGN KEY ("tenantId", "prepackId") REFERENCES "Prepack"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrepackLine" ADD CONSTRAINT "PrepackLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProtectorPlacement" ADD CONSTRAINT "ProtectorPlacement_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProtectorPlacement" ADD CONSTRAINT "ProtectorPlacement_tenantId_protectorItemId_fkey" FOREIGN KEY ("tenantId", "protectorItemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementRule" ADD CONSTRAINT "MeasurementRule_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "MeasurementTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementRule" ADD CONSTRAINT "MeasurementRule_tenantId_templateId_pointId_fkey" FOREIGN KEY ("tenantId", "templateId", "pointId") REFERENCES "MeasurementPoint"("tenantId", "templateId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementRule" ADD CONSTRAINT "MeasurementRule_tenantId_templateId_otherPointId_fkey" FOREIGN KEY ("tenantId", "templateId", "otherPointId") REFERENCES "MeasurementPoint"("tenantId", "templateId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

