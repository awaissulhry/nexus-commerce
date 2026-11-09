-- CreateEnum
CREATE TYPE "BomSection" AS ENUM ('SHELL', 'LINING', 'INSULATION', 'PROTECTION', 'TRIMS', 'THREAD', 'LABELS', 'PACKAGING', 'OTHER');

-- CreateEnum
CREATE TYPE "BomAlternateUse" AS ENUM ('ALWAYS', 'WHEN_SHORT', 'WITH_APPROVAL');

-- CreateEnum
CREATE TYPE "OptionGroupKind" AS ENUM ('SINGLE', 'MULTI', 'FREE_TEXT');

-- CreateEnum
CREATE TYPE "OptionRuleKind" AS ENUM ('REQUIRES', 'EXCLUDES');

-- CreateEnum
CREATE TYPE "OptionRuleSeverity" AS ENUM ('BLOCK', 'WARN');

-- CreateEnum
CREATE TYPE "OptionEffectKind" AS ENUM ('BOM_ADD', 'BOM_REPLACE', 'BOM_REMOVE', 'OPERATION_ADD', 'MINUTES', 'PRICE', 'CERTIFICATE');

-- AlterTable
ALTER TABLE "BomLine" ADD COLUMN     "customerSuppliedByPartyId" UUID,
ADD COLUMN     "issueToSubcontract" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "optionValueId" UUID,
ADD COLUMN     "parentLineId" UUID,
ADD COLUMN     "section" "BomSection",
ADD COLUMN     "sourceKey" TEXT,
ADD COLUMN     "subAssemblyRevisionId" UUID,
ADD COLUMN     "subAssemblyStyleId" UUID;

-- AlterTable
ALTER TABLE "StyleRevision" ADD COLUMN     "outputQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "outputUom" "Uom" NOT NULL DEFAULT 'PCS';

-- CreateTable
CREATE TABLE "BomLineAlternate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "revisionId" UUID NOT NULL,
    "bomLineId" UUID NOT NULL,
    "priority" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "qty" DECIMAL(18,4),
    "allowedWhen" "BomAlternateUse" NOT NULL DEFAULT 'WITH_APPROVAL',
    "certificateCheck" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BomLineAlternate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "description" TEXT,
    "kind" "OptionGroupKind" NOT NULL,
    "minPicks" INTEGER NOT NULL DEFAULT 0,
    "maxPicks" INTEGER,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionValue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "groupId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "freeText" BOOLEAN NOT NULL DEFAULT false,
    "freeTextMaxLength" INTEGER,
    "freeTextPattern" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OptionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "groupId" UUID NOT NULL,
    "valueId" UUID,
    "kind" "OptionRuleKind" NOT NULL,
    "otherValueId" UUID NOT NULL,
    "severity" "OptionRuleSeverity" NOT NULL,
    "messageI18n" JSONB,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OptionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionEffect" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "valueId" UUID NOT NULL,
    "kind" "OptionEffectKind" NOT NULL,
    "itemId" UUID,
    "itemColourId" UUID,
    "targetItemId" UUID,
    "qty" DECIMAL(18,4),
    "uom" "Uom",
    "sizeQuantities" JSONB,
    "section" "BomSection",
    "operationId" UUID,
    "minutes" DECIMAL(10,3),
    "priceDelta" DECIMAL(18,6),
    "currency" TEXT,
    "pricePct" DECIMAL(7,4),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OptionEffect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleOptionGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "minPicks" INTEGER,
    "maxPicks" INTEGER,
    "defaultValueId" UUID,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StyleOptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BomLineAlternate_tenantId_itemId_idx" ON "BomLineAlternate"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "BomLineAlternate_tenantId_bomLineId_priority_key" ON "BomLineAlternate"("tenantId", "bomLineId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "OptionGroup_tenantId_code_key" ON "OptionGroup"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OptionGroup_tenantId_id_key" ON "OptionGroup"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_tenantId_groupId_code_key" ON "OptionValue"("tenantId", "groupId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_tenantId_groupId_id_key" ON "OptionValue"("tenantId", "groupId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_tenantId_id_key" ON "OptionValue"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OptionRule_tenantId_groupId_idx" ON "OptionRule"("tenantId", "groupId");

-- CreateIndex
CREATE INDEX "OptionRule_tenantId_otherValueId_idx" ON "OptionRule"("tenantId", "otherValueId");

-- CreateIndex
CREATE INDEX "OptionEffect_tenantId_valueId_idx" ON "OptionEffect"("tenantId", "valueId");

-- CreateIndex
CREATE INDEX "StyleOptionGroup_tenantId_styleId_idx" ON "StyleOptionGroup"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "StyleOptionGroup_tenantId_groupId_idx" ON "StyleOptionGroup"("tenantId", "groupId");

-- CreateIndex
CREATE INDEX "BomLine_tenantId_revisionId_parentLineId_idx" ON "BomLine"("tenantId", "revisionId", "parentLineId");

-- CreateIndex
CREATE INDEX "BomLine_tenantId_subAssemblyStyleId_subAssemblyRevisionId_idx" ON "BomLine"("tenantId", "subAssemblyStyleId", "subAssemblyRevisionId");

-- AddForeignKey
ALTER TABLE "BomLineAlternate" ADD CONSTRAINT "BomLineAlternate_tenantId_revisionId_bomLineId_fkey" FOREIGN KEY ("tenantId", "revisionId", "bomLineId") REFERENCES "BomLine"("tenantId", "revisionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLineAlternate" ADD CONSTRAINT "BomLineAlternate_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLineAlternate" ADD CONSTRAINT "BomLineAlternate_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionGroup" ADD CONSTRAINT "OptionGroup_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "OptionGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionRule" ADD CONSTRAINT "OptionRule_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "OptionGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionRule" ADD CONSTRAINT "OptionRule_tenantId_groupId_valueId_fkey" FOREIGN KEY ("tenantId", "groupId", "valueId") REFERENCES "OptionValue"("tenantId", "groupId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionRule" ADD CONSTRAINT "OptionRule_tenantId_otherValueId_fkey" FOREIGN KEY ("tenantId", "otherValueId") REFERENCES "OptionValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionEffect" ADD CONSTRAINT "OptionEffect_tenantId_valueId_fkey" FOREIGN KEY ("tenantId", "valueId") REFERENCES "OptionValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionEffect" ADD CONSTRAINT "OptionEffect_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionEffect" ADD CONSTRAINT "OptionEffect_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionEffect" ADD CONSTRAINT "OptionEffect_tenantId_targetItemId_fkey" FOREIGN KEY ("tenantId", "targetItemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OptionEffect" ADD CONSTRAINT "OptionEffect_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleOptionGroup" ADD CONSTRAINT "StyleOptionGroup_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleOptionGroup" ADD CONSTRAINT "StyleOptionGroup_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "OptionGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StyleOptionGroup" ADD CONSTRAINT "StyleOptionGroup_tenantId_groupId_defaultValueId_fkey" FOREIGN KEY ("tenantId", "groupId", "defaultValueId") REFERENCES "OptionValue"("tenantId", "groupId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_revisionId_parentLineId_fkey" FOREIGN KEY ("tenantId", "revisionId", "parentLineId") REFERENCES "BomLine"("tenantId", "revisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_subAssemblyStyleId_subAssemblyRevisionId_fkey" FOREIGN KEY ("tenantId", "subAssemblyStyleId", "subAssemblyRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_customerSuppliedByPartyId_fkey" FOREIGN KEY ("tenantId", "customerSuppliedByPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_tenantId_optionValueId_fkey" FOREIGN KEY ("tenantId", "optionValueId") REFERENCES "OptionValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

