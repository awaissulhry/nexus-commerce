-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'MONEY', 'DATE', 'SELECT', 'MULTI_SELECT', 'PERSON', 'LINK', 'FILE', 'YES_NO');

-- CreateEnum
CREATE TYPE "CustomFieldAudience" AS ENUM ('INTERNAL', 'MONEY', 'PERSONAL');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "DocumentTemplateKind" AS ENUM ('QUOTE', 'ORDER_CONFIRMATION', 'PURCHASE_ORDER', 'DDT', 'INVOICE_COPY', 'PACKING_LIST');

-- CreateTable
CREATE TABLE "CustomField" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "recordType" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "section" TEXT NOT NULL DEFAULT 'custom',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "unit" TEXT,
    "audience" "CustomFieldAudience" NOT NULL DEFAULT 'INTERNAL',
    "grain" TEXT,
    "shownInPortal" BOOLEAN NOT NULL DEFAULT false,
    "picklistId" UUID,
    "linkTo" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CustomField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldValue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "fieldId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL,
    "changedById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Picklist" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Picklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PicklistValue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "picklistId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "colour" TEXT,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PicklistValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "kind" "DocumentTemplateKind" NOT NULL,
    "language" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "header" TEXT,
    "terms" TEXT,
    "footer" TEXT,
    "fieldsShown" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "retiredAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "event" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "retiredAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recordType" TEXT,
    "ownerId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteTemplateLineOption" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "lineId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "valueId" UUID NOT NULL,
    "freeText" TEXT,
    "colourId" UUID,
    "itemId" UUID,
    "itemColourId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteTemplateLineOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomField_tenantId_recordType_status_idx" ON "CustomField"("tenantId", "recordType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomField_tenantId_key_key" ON "CustomField"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CustomField_tenantId_id_key" ON "CustomField"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CustomFieldValue_tenantId_recordType_recordId_idx" ON "CustomFieldValue"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "CustomFieldValue_tenantId_fieldId_idx" ON "CustomFieldValue"("tenantId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldValue_tenantId_key_key" ON "CustomFieldValue"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Picklist_tenantId_key_key" ON "Picklist"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Picklist_tenantId_id_key" ON "Picklist"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PicklistValue_tenantId_picklistId_sortOrder_idx" ON "PicklistValue"("tenantId", "picklistId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PicklistValue_tenantId_key_key" ON "PicklistValue"("tenantId", "key");

-- CreateIndex
CREATE INDEX "DocumentTemplate_tenantId_companyId_kind_language_status_idx" ON "DocumentTemplate"("tenantId", "companyId", "kind", "language", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_tenantId_key_key" ON "DocumentTemplate"("tenantId", "key");

-- CreateIndex
CREATE INDEX "EmailTemplate_tenantId_event_language_status_idx" ON "EmailTemplate"("tenantId", "event", "language", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_tenantId_key_key" ON "EmailTemplate"("tenantId", "key");

-- CreateIndex
CREATE INDEX "MessageTemplate_tenantId_language_recordType_idx" ON "MessageTemplate"("tenantId", "language", "recordType");

-- CreateIndex
CREATE INDEX "MessageTemplate_tenantId_ownerId_idx" ON "MessageTemplate"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "QuoteTemplateLineOption_tenantId_lineId_idx" ON "QuoteTemplateLineOption"("tenantId", "lineId");

-- CreateIndex
CREATE INDEX "QuoteTemplateLineOption_tenantId_valueId_idx" ON "QuoteTemplateLineOption"("tenantId", "valueId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteTemplateLine_tenantId_id_key" ON "QuoteTemplateLine"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "CustomField" ADD CONSTRAINT "CustomField_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomField" ADD CONSTRAINT "CustomField_tenantId_picklistId_fkey" FOREIGN KEY ("tenantId", "picklistId") REFERENCES "Picklist"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_tenantId_fieldId_fkey" FOREIGN KEY ("tenantId", "fieldId") REFERENCES "CustomField"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Picklist" ADD CONSTRAINT "Picklist_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PicklistValue" ADD CONSTRAINT "PicklistValue_tenantId_picklistId_fkey" FOREIGN KEY ("tenantId", "picklistId") REFERENCES "Picklist"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_tenantId_ownerId_fkey" FOREIGN KEY ("tenantId", "ownerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLineOption" ADD CONSTRAINT "QuoteTemplateLineOption_tenantId_lineId_fkey" FOREIGN KEY ("tenantId", "lineId") REFERENCES "QuoteTemplateLine"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLineOption" ADD CONSTRAINT "QuoteTemplateLineOption_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "OptionGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLineOption" ADD CONSTRAINT "QuoteTemplateLineOption_tenantId_groupId_valueId_fkey" FOREIGN KEY ("tenantId", "groupId", "valueId") REFERENCES "OptionValue"("tenantId", "groupId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLineOption" ADD CONSTRAINT "QuoteTemplateLineOption_tenantId_colourId_fkey" FOREIGN KEY ("tenantId", "colourId") REFERENCES "Colour"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLineOption" ADD CONSTRAINT "QuoteTemplateLineOption_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteTemplateLineOption" ADD CONSTRAINT "QuoteTemplateLineOption_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

