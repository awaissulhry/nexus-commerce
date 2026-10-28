-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('DRAFT', 'VALID', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LabelTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ComplianceDocumentKind" AS ENUM ('DECLARATION_OF_CONFORMITY', 'USER_INFORMATION');

-- CreateEnum
CREATE TYPE "ComplianceDocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ItemKind" AS ENUM ('LEATHER', 'TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'THREAD', 'TRIM', 'HARDWARE', 'PROTECTOR', 'LABEL', 'PACKAGING', 'COMPONENT');

-- CreateEnum
CREATE TYPE "ItemSourcing" AS ENUM ('BUY', 'MAKE', 'MAKE_OR_BUY');

-- CreateEnum
CREATE TYPE "ItemTracking" AS ENUM ('NONE', 'LOT', 'HIDE', 'SERIAL');

-- CreateEnum
CREATE TYPE "Tannage" AS ENUM ('CHROME', 'VEGETABLE', 'CHROME_FREE', 'COMBINATION');

-- CreateEnum
CREATE TYPE "Uom" AS ENUM ('PCS', 'PAIR', 'SET', 'M', 'CM', 'MM', 'M2', 'DM2', 'FT2', 'KG', 'G', 'L', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX');

-- CreateEnum
CREATE TYPE "StyleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER');

-- CreateEnum
CREATE TYPE "PpeCategory" AS ENUM ('NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III');

-- CreateEnum
CREATE TYPE "StyleRevisionStatus" AS ENUM ('DRAFT', 'RELEASED', 'OBSOLETE');

-- CreateTable
CREATE TABLE "Certificate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "holderPartyId" UUID,
    "standard" TEXT NOT NULL,
    "ppeClass" TEXT,
    "number" TEXT NOT NULL,
    "notifiedBodyName" TEXT NOT NULL,
    "notifiedBodyNumber" TEXT NOT NULL,
    "modelReference" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "status" "CertificateStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertificateCoverage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "certificateId" UUID NOT NULL,
    "styleId" UUID,
    "itemId" UUID,
    "colourwayIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowsMadeToMeasure" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CertificateCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "styleId" UUID,
    "status" "LabelTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "makerPartyId" UUID,
    "makerName" TEXT NOT NULL,
    "makerAddress" TEXT NOT NULL,
    "importerName" TEXT,
    "importerAddress" TEXT,
    "composition" JSONB,
    "animalOriginPhrase" BOOLEAN NOT NULL DEFAULT false,
    "care" JSONB,
    "layout" JSONB NOT NULL,
    "widthMm" DECIMAL(6,2) NOT NULL,
    "heightMm" DECIMAL(6,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LabelTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "styleId" UUID NOT NULL,
    "kind" "ComplianceDocumentKind" NOT NULL,
    "language" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "number" TEXT,
    "status" "ComplianceDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "certificateId" UUID,
    "makerPartyId" UUID,
    "makerName" TEXT NOT NULL,
    "makerAddress" TEXT NOT NULL,
    "productIdentification" TEXT,
    "standards" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signedByName" TEXT,
    "signedByFunction" TEXT,
    "signedPlace" TEXT,
    "signedOn" DATE,
    "issuedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ComplianceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Colour" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "hex" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Colour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "kind" "ItemKind" NOT NULL,
    "sourcing" "ItemSourcing" NOT NULL DEFAULT 'BUY',
    "tracking" "ItemTracking" NOT NULL DEFAULT 'NONE',
    "baseUom" "Uom" NOT NULL,
    "purchaseUom" "Uom" NOT NULL,
    "purchaseFactor" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "consumptionUom" "Uom" NOT NULL,
    "consumptionFactor" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "defaultSupplierId" UUID,
    "supplierArticleCode" TEXT,
    "standardCost" DECIMAL(18,6),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "animalSpecies" TEXT,
    "tannage" "Tannage",
    "grade" TEXT,
    "finish" TEXT,
    "thicknessMinMm" DECIMAL(6,2),
    "thicknessMaxMm" DECIMAL(6,2),
    "composition" JSONB,
    "animalOrigin" BOOLEAN NOT NULL DEFAULT false,
    "attributes" JSONB,
    "isPpeComponent" BOOLEAN NOT NULL DEFAULT false,
    "requiresCrViTest" BOOLEAN NOT NULL DEFAULT false,
    "crViLimitMgKg" DECIMAL(8,3),
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemColour" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "itemId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colourId" UUID,
    "supplierColourCode" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ItemColour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeScale" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SizeScale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Size" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "scaleId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "seq" INTEGER NOT NULL,
    "bodyMeasures" JSONB,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Size_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Style" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "description" TEXT,
    "productType" "ProductType" NOT NULL,
    "season" TEXT,
    "brandPartyId" UUID,
    "sizeScaleId" UUID NOT NULL,
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "baseSize" TEXT,
    "ppeCategory" "PpeCategory" NOT NULL,
    "ppeStandard" TEXT,
    "ppeClass" TEXT,
    "mtmAllowed" BOOLEAN NOT NULL DEFAULT false,
    "measurementTemplateId" UUID,
    "status" "StyleStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Style_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Colourway" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colourId" UUID,
    "description" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Colourway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "colourwayId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "gtin" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleRevision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "StyleRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "changeNote" TEXT,
    "plannedHideYieldPct" DECIMAL(7,4),
    "labelTemplateId" UUID,
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "placement" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "wastagePct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "sizeDependent" BOOLEAN NOT NULL DEFAULT false,
    "colourDependent" BOOLEAN NOT NULL DEFAULT false,
    "itemColourId" UUID,
    "colourwayId" UUID,
    "supplierId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BomLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomLineSize" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "revisionId" UUID NOT NULL,
    "bomLineId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BomLineSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomLineColour" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "bomLineId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "colourwayId" UUID NOT NULL,
    "itemColourId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BomLineColour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "workCentreKind" "WorkCentreKind" NOT NULL,
    "machineType" TEXT,
    "skill" TEXT,
    "standardMinutes" DECIMAL(10,3) NOT NULL,
    "instructions" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingOperation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "operationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "workCentreKind" "WorkCentreKind" NOT NULL,
    "standardMinutes" DECIMAL(10,3) NOT NULL,
    "scanRequired" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RoutingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "productType" "ProductType" NOT NULL,
    "instructions" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MeasurementTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementPoint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "templateId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "seq" INTEGER NOT NULL,
    "uom" "Uom" NOT NULL DEFAULT 'CM',
    "minValue" DECIMAL(8,2),
    "maxValue" DECIMAL(8,2),
    "required" BOOLEAN NOT NULL DEFAULT true,
    "howTo" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MeasurementPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_tenantId_notifiedBodyNumber_number_key" ON "Certificate"("tenantId", "notifiedBodyNumber", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_tenantId_id_key" ON "Certificate"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CertificateCoverage_tenantId_certificateId_idx" ON "CertificateCoverage"("tenantId", "certificateId");

-- CreateIndex
CREATE INDEX "CertificateCoverage_tenantId_styleId_idx" ON "CertificateCoverage"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "CertificateCoverage_tenantId_itemId_idx" ON "CertificateCoverage"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "LabelTemplate_tenantId_code_revision_key" ON "LabelTemplate"("tenantId", "code", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "LabelTemplate_tenantId_id_key" ON "LabelTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceDocument_tenantId_styleId_kind_language_revision_key" ON "ComplianceDocument"("tenantId", "styleId", "kind", "language", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "Colour_tenantId_code_key" ON "Colour"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Colour_tenantId_id_key" ON "Colour"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Item_tenantId_code_key" ON "Item"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Item_tenantId_id_key" ON "Item"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ItemColour_tenantId_itemId_code_key" ON "ItemColour"("tenantId", "itemId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ItemColour_tenantId_itemId_id_key" ON "ItemColour"("tenantId", "itemId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SizeScale_tenantId_code_key" ON "SizeScale"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SizeScale_tenantId_id_key" ON "SizeScale"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Size_tenantId_scaleId_code_key" ON "Size"("tenantId", "scaleId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Style_tenantId_code_key" ON "Style"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Style_tenantId_id_key" ON "Style"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Colourway_tenantId_styleId_code_key" ON "Colourway"("tenantId", "styleId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Colourway_tenantId_styleId_id_key" ON "Colourway"("tenantId", "styleId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_tenantId_sku_key" ON "Variant"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_tenantId_gtin_key" ON "Variant"("tenantId", "gtin");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_tenantId_styleId_colourwayId_size_key" ON "Variant"("tenantId", "styleId", "colourwayId", "size");

-- CreateIndex
CREATE UNIQUE INDEX "StyleRevision_tenantId_styleId_revision_key" ON "StyleRevision"("tenantId", "styleId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "StyleRevision_tenantId_styleId_id_key" ON "StyleRevision"("tenantId", "styleId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BomLine_tenantId_revisionId_seq_key" ON "BomLine"("tenantId", "revisionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "BomLine_tenantId_revisionId_id_key" ON "BomLine"("tenantId", "revisionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BomLine_tenantId_revisionId_id_itemId_key" ON "BomLine"("tenantId", "revisionId", "id", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "BomLineSize_tenantId_bomLineId_size_key" ON "BomLineSize"("tenantId", "bomLineId", "size");

-- CreateIndex
CREATE INDEX "BomLineColour_tenantId_bomLineId_idx" ON "BomLineColour"("tenantId", "bomLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_tenantId_code_key" ON "Operation"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_tenantId_id_key" ON "Operation"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingOperation_tenantId_revisionId_seq_key" ON "RoutingOperation"("tenantId", "revisionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementTemplate_tenantId_code_key" ON "MeasurementTemplate"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementTemplate_tenantId_id_key" ON "MeasurementTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementPoint_tenantId_templateId_code_key" ON "MeasurementPoint"("tenantId", "templateId", "code");

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_tenantId_holderPartyId_fkey" FOREIGN KEY ("tenantId", "holderPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CertificateCoverage" ADD CONSTRAINT "CertificateCoverage_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CertificateCoverage" ADD CONSTRAINT "CertificateCoverage_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CertificateCoverage" ADD CONSTRAINT "CertificateCoverage_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_tenantId_makerPartyId_fkey" FOREIGN KEY ("tenantId", "makerPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_tenantId_makerPartyId_fkey" FOREIGN KEY ("tenantId", "makerPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Colour" ADD CONSTRAINT "Colour_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_defaultSupplierId_fkey" FOREIGN KEY ("tenantId", "defaultSupplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemColour" ADD CONSTRAINT "ItemColour_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemColour" ADD CONSTRAINT "ItemColour_tenantId_colourId_fkey" FOREIGN KEY ("tenantId", "colourId") REFERENCES "Colour"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SizeScale" ADD CONSTRAINT "SizeScale_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Size" ADD CONSTRAINT "Size_tenantId_scaleId_fkey" FOREIGN KEY ("tenantId", "scaleId") REFERENCES "SizeScale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_brandPartyId_fkey" FOREIGN KEY ("tenantId", "brandPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_sizeScaleId_fkey" FOREIGN KEY ("tenantId", "sizeScaleId") REFERENCES "SizeScale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_measurementTemplateId_fkey" FOREIGN KEY ("tenantId", "measurementTemplateId") REFERENCES "MeasurementTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Colourway" ADD CONSTRAINT "Colourway_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Colourway" ADD CONSTRAINT "Colourway_tenantId_colourId_fkey" FOREIGN KEY ("tenantId", "colourId") REFERENCES "Colour"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRevision" ADD CONSTRAINT "StyleRevision_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleRevision" ADD CONSTRAINT "StyleRevision_tenantId_labelTemplateId_fkey" FOREIGN KEY ("tenantId", "labelTemplateId") REFERENCES "LabelTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLineSize" ADD CONSTRAINT "BomLineSize_tenantId_revisionId_bomLineId_fkey" FOREIGN KEY ("tenantId", "revisionId", "bomLineId") REFERENCES "BomLine"("tenantId", "revisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLineColour" ADD CONSTRAINT "BomLineColour_tenantId_revisionId_bomLineId_itemId_fkey" FOREIGN KEY ("tenantId", "revisionId", "bomLineId", "itemId") REFERENCES "BomLine"("tenantId", "revisionId", "id", "itemId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLineColour" ADD CONSTRAINT "BomLineColour_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLineColour" ADD CONSTRAINT "BomLineColour_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLineColour" ADD CONSTRAINT "BomLineColour_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementTemplate" ADD CONSTRAINT "MeasurementTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementPoint" ADD CONSTRAINT "MeasurementPoint_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "MeasurementTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

