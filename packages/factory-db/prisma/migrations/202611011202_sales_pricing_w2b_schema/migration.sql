-- CreateEnum
CREATE TYPE "QuoteAcceptanceMode" AS ENUM ('SIGN', 'PAY', 'SIGN_AND_PAY');

-- CreateEnum
CREATE TYPE "SalesFeeKind" AS ENUM ('DEVELOPMENT', 'SAMPLE', 'TOOLING');

-- CreateEnum
CREATE TYPE "MoqPer" AS ENUM ('ORDER', 'COLOURWAY', 'LINE');

-- CreateEnum
CREATE TYPE "MoqAction" AS ENUM ('BLOCK', 'WARN', 'SURCHARGE');

-- AlterEnum
ALTER TYPE "FileCategory" ADD VALUE 'ARTWORK';

-- AlterEnum
ALTER TYPE "ReasonList" ADD VALUE 'PRICE_ADJUSTMENT';

-- AlterEnum
ALTER TYPE "SalesLineKind" ADD VALUE 'FEE';

-- AlterTable
ALTER TABLE "PriceList" ADD COLUMN     "showDiscount" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PriceListEntry" ADD COLUMN     "validFrom" DATE,
ADD COLUMN     "validTo" DATE;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "templateId" UUID;

-- AlterTable
ALTER TABLE "QuoteLine" ADD COLUMN     "feeKind" "SalesFeeKind",
ADD COLUMN     "priceSteps" JSONB,
ADD COLUMN     "section" TEXT;

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN     "acceptanceMode" "QuoteAcceptanceMode" NOT NULL DEFAULT 'SIGN',
ADD COLUMN     "incoterm" TEXT,
ADD COLUMN     "incotermPlace" TEXT,
ADD COLUMN     "reminderSentAt" TIMESTAMPTZ(3),
ADD COLUMN     "shipComplete" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "incoterm" TEXT,
ADD COLUMN     "incotermPlace" TEXT,
ADD COLUMN     "shipComplete" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN     "feeKind" "SalesFeeKind",
ADD COLUMN     "priceSteps" JSONB;

-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "marginFloorByRole" JSONB;

-- AlterTable
ALTER TABLE "WorkOrderSize" ADD COLUMN     "optionValueIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "QuoteTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "language" TEXT NOT NULL DEFAULT 'it',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "validityDays" INTEGER,
    "firmOffer" BOOLEAN NOT NULL DEFAULT false,
    "acceptanceMode" "QuoteAcceptanceMode" NOT NULL DEFAULT 'SIGN',
    "depositPct" DECIMAL(7,4),
    "depositKind" "DepositKind",
    "paymentTermsId" UUID,
    "termsText" TEXT,
    "termsVersion" TEXT,
    "incoterm" TEXT,
    "incotermPlace" TEXT,
    "shipComplete" BOOLEAN NOT NULL DEFAULT false,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteTemplateLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "templateId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "section" TEXT,
    "kind" "SalesLineKind" NOT NULL,
    "feeKind" "SalesFeeKind",
    "styleId" UUID NOT NULL,
    "colourwayId" UUID,
    "sizeQuantities" JSONB,
    "unitPrice" DECIMAL(18,6),
    "description" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteTemplateLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLineDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "lineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "sizeQuantities" JSONB,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteLineDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLineDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "lineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "sizeQuantities" JSONB,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrderLineDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLineOption" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "lineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "valueId" UUID NOT NULL,
    "freeText" TEXT,
    "byDefault" BOOLEAN NOT NULL DEFAULT false,
    "colourId" UUID,
    "itemId" UUID,
    "itemColourId" UUID,
    "surchargeAmount" DECIMAL(18,6),
    "surchargePct" DECIMAL(7,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteLineOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLineOption" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "lineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "valueId" UUID NOT NULL,
    "freeText" TEXT,
    "byDefault" BOOLEAN NOT NULL DEFAULT false,
    "colourId" UUID,
    "itemId" UUID,
    "itemColourId" UUID,
    "surchargeAmount" DECIMAL(18,6),
    "surchargePct" DECIMAL(7,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrderLineOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBreak" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID NOT NULL,
    "entryId" UUID,
    "minQuantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18,6),
    "discountPct" DECIMAL(7,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PriceBreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeSurcharge" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID,
    "styleId" UUID,
    "size" TEXT NOT NULL,
    "surchargeAmount" DECIMAL(18,6),
    "currency" TEXT,
    "surchargePct" DECIMAL(7,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SizeSurcharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoqRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "priceListId" UUID,
    "styleId" UUID,
    "productType" "ProductType",
    "itemId" UUID,
    "minQuantity" INTEGER NOT NULL,
    "per" "MoqPer" NOT NULL,
    "action" "MoqAction" NOT NULL,
    "surchargeAmount" DECIMAL(18,6),
    "currency" TEXT,
    "surchargePct" DECIMAL(7,4),
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MoqRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeCurve" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "sizeScaleId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shares" JSONB NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SizeCurve_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteTemplate_tenantId_companyId_idx" ON "QuoteTemplate"("tenantId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteTemplate_tenantId_id_key" ON "QuoteTemplate"("tenantId", "id");

-- CreateIndex
CREATE INDEX "QuoteTemplateLine_tenantId_styleId_idx" ON "QuoteTemplateLine"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteTemplateLine_tenantId_templateId_seq_key" ON "QuoteTemplateLine"("tenantId", "templateId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteLineDelivery_tenantId_lineId_deliveryDate_key" ON "QuoteLineDelivery"("tenantId", "lineId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLineDelivery_tenantId_lineId_deliveryDate_key" ON "SalesOrderLineDelivery"("tenantId", "lineId", "deliveryDate");

-- CreateIndex
CREATE INDEX "QuoteLineOption_tenantId_lineId_idx" ON "QuoteLineOption"("tenantId", "lineId");

-- CreateIndex
CREATE INDEX "QuoteLineOption_tenantId_valueId_idx" ON "QuoteLineOption"("tenantId", "valueId");

-- CreateIndex
CREATE INDEX "SalesOrderLineOption_tenantId_lineId_idx" ON "SalesOrderLineOption"("tenantId", "lineId");

-- CreateIndex
CREATE INDEX "SalesOrderLineOption_tenantId_valueId_idx" ON "SalesOrderLineOption"("tenantId", "valueId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBreak_tenantId_versionId_entryId_minQuantity_key" ON "PriceBreak"("tenantId", "versionId", "entryId", "minQuantity");

-- CreateIndex
CREATE INDEX "SizeSurcharge_tenantId_styleId_idx" ON "SizeSurcharge"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "SizeSurcharge_tenantId_versionId_styleId_size_key" ON "SizeSurcharge"("tenantId", "versionId", "styleId", "size");

-- CreateIndex
CREATE INDEX "MoqRule_tenantId_styleId_idx" ON "MoqRule"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "MoqRule_tenantId_companyId_idx" ON "MoqRule"("tenantId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SizeCurve_tenantId_sizeScaleId_name_key" ON "SizeCurve"("tenantId", "sizeScaleId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListEntry_tenantId_versionId_id_key" ON "PriceListEntry"("tenantId", "versionId", "id");

-- AddForeignKey
ALTER TABLE "QuoteTemplate" ADD CONSTRAINT "QuoteTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplate" ADD CONSTRAINT "QuoteTemplate_tenantId_paymentTermsId_fkey" FOREIGN KEY ("tenantId", "paymentTermsId") REFERENCES "PaymentTerms"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLine" ADD CONSTRAINT "QuoteTemplateLine_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "QuoteTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLine" ADD CONSTRAINT "QuoteTemplateLine_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLine" ADD CONSTRAINT "QuoteTemplateLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineDelivery" ADD CONSTRAINT "QuoteLineDelivery_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "QuoteLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineDelivery" ADD CONSTRAINT "SalesOrderLineDelivery_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineOption" ADD CONSTRAINT "QuoteLineOption_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "QuoteLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineOption" ADD CONSTRAINT "QuoteLineOption_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "OptionGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineOption" ADD CONSTRAINT "QuoteLineOption_tenantId_groupId_valueId_fkey" FOREIGN KEY ("tenantId", "groupId", "valueId") REFERENCES "OptionValue"("tenantId", "groupId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineOption" ADD CONSTRAINT "QuoteLineOption_tenantId_colourId_fkey" FOREIGN KEY ("tenantId", "colourId") REFERENCES "Colour"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineOption" ADD CONSTRAINT "QuoteLineOption_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineOption" ADD CONSTRAINT "QuoteLineOption_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineOption" ADD CONSTRAINT "SalesOrderLineOption_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineOption" ADD CONSTRAINT "SalesOrderLineOption_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "OptionGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineOption" ADD CONSTRAINT "SalesOrderLineOption_tenantId_groupId_valueId_fkey" FOREIGN KEY ("tenantId", "groupId", "valueId") REFERENCES "OptionValue"("tenantId", "groupId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineOption" ADD CONSTRAINT "SalesOrderLineOption_tenantId_colourId_fkey" FOREIGN KEY ("tenantId", "colourId") REFERENCES "Colour"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineOption" ADD CONSTRAINT "SalesOrderLineOption_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineOption" ADD CONSTRAINT "SalesOrderLineOption_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceBreak" ADD CONSTRAINT "PriceBreak_tenantId_versionId_fkey" FOREIGN KEY ("tenantId", "versionId") REFERENCES "PriceListVersion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceBreak" ADD CONSTRAINT "PriceBreak_tenantId_versionId_entryId_fkey" FOREIGN KEY ("tenantId", "versionId", "entryId") REFERENCES "PriceListEntry"("tenantId", "versionId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SizeSurcharge" ADD CONSTRAINT "SizeSurcharge_tenantId_versionId_fkey" FOREIGN KEY ("tenantId", "versionId") REFERENCES "PriceListVersion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SizeSurcharge" ADD CONSTRAINT "SizeSurcharge_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MoqRule" ADD CONSTRAINT "MoqRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MoqRule" ADD CONSTRAINT "MoqRule_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "PriceList"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MoqRule" ADD CONSTRAINT "MoqRule_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MoqRule" ADD CONSTRAINT "MoqRule_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SizeCurve" ADD CONSTRAINT "SizeCurve_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SizeCurve" ADD CONSTRAINT "SizeCurve_tenantId_sizeScaleId_fkey" FOREIGN KEY ("tenantId", "sizeScaleId") REFERENCES "SizeScale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "QuoteTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

