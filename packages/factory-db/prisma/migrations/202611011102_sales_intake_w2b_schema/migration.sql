-- CreateEnum
CREATE TYPE "InquirySource" AS ENUM ('OFFICE', 'MAIL', 'PORTAL', 'PHONE', 'FAIR');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('NEW', 'ASSIGNED', 'NEED_INFO', 'QUOTED', 'DECLINED', 'LOST');

-- CreateEnum
CREATE TYPE "InquiryDeclineReason" AS ENUM ('CAPACITY', 'LEAD_TIME', 'NOT_OUR_PRODUCT', 'PRICE', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactLawfulBasis" AS ENUM ('CONTRACT', 'CONSENT', 'LEGITIMATE_INTEREST', 'LEGAL_DUTY');

-- CreateEnum
CREATE TYPE "CustomerRequirementKind" AS ENUM ('PACKING', 'DOCUMENT', 'LABEL', 'QUALITY', 'SHIPPING', 'INVOICING', 'OTHER');

-- CreateEnum
CREATE TYPE "RequirementStage" AS ENUM ('QUOTE', 'ORDER', 'PACKING', 'SHIPMENT', 'INVOICE');

-- CreateEnum
CREATE TYPE "PartyHoldReason" AS ENUM ('CREDIT', 'LEGAL', 'QUALITY_DISPUTE', 'DATA_MISSING', 'OTHER');

-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'INQUIRY';

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "teamPartyId" UUID;

-- AlterTable
ALTER TABLE "PartyContact" ADD COLUMN     "consentAt" TIMESTAMPTZ(3),
ADD COLUMN     "consentSource" TEXT,
ADD COLUMN     "erasedAt" TIMESTAMPTZ(3),
ADD COLUMN     "erasedById" UUID,
ADD COLUMN     "lawfulBasis" "ContactLawfulBasis",
ADD COLUMN     "objectedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN     "seasonId" UUID;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "seasonId" UUID;

-- CreateTable
CREATE TABLE "Inquiry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "source" "InquirySource" NOT NULL,
    "sourceEmailId" UUID,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "partyId" UUID,
    "contactId" UUID,
    "prospectName" TEXT,
    "prospectCompany" TEXT,
    "prospectEmail" TEXT,
    "prospectPhone" TEXT,
    "prospectLawfulBasis" "ContactLawfulBasis",
    "prospectErasedAt" TIMESTAMPTZ(3),
    "prospectErasedById" UUID,
    "request" TEXT NOT NULL,
    "wantedDate" DATE,
    "targetUnitPrice" DECIMAL(18,6),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "techPackFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "techPackVersion" TEXT,
    "status" "InquiryStatus" NOT NULL DEFAULT 'NEW',
    "assigneeId" UUID,
    "assignedAt" TIMESTAMPTZ(3),
    "quoteId" UUID,
    "declineReason" "InquiryDeclineReason",
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeNote" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InquiryLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "inquiryId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "styleId" UUID,
    "colourwayId" UUID,
    "colourText" TEXT,
    "description" TEXT,
    "sizes" JSONB NOT NULL DEFAULT '{}',
    "quantity" INTEGER,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InquiryLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerRequirement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "companyId" UUID,
    "kind" "CustomerRequirementKind" NOT NULL,
    "words" TEXT NOT NULL,
    "appliesAt" "RequirementStage"[],
    "styleIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "fileId" UUID,
    "supersedesId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,
    "endReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CustomerRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyHold" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "companyId" UUID,
    "reason" "PartyHoldReason" NOT NULL,
    "words" TEXT NOT NULL,
    "placedAt" TIMESTAMPTZ(3) NOT NULL,
    "placedById" UUID,
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "releaseWords" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyCompanyTerms" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "paymentTerms" TEXT,
    "paymentTermsId" UUID,
    "priceListId" UUID,
    "depositPct" DECIMAL(7,4),
    "poNumberRequired" BOOLEAN NOT NULL DEFAULT false,
    "creditLimitAmount" INTEGER,
    "creditLimitCurrency" TEXT,
    "updatedById" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyCompanyTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "orderBookClosesOn" DATE,
    "status" "SeasonStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Inquiry_tenantId_companyId_status_receivedAt_idx" ON "Inquiry"("tenantId", "companyId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "Inquiry_tenantId_assigneeId_status_idx" ON "Inquiry"("tenantId", "assigneeId", "status");

-- CreateIndex
CREATE INDEX "Inquiry_tenantId_partyId_idx" ON "Inquiry"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_tenantId_companyId_number_key" ON "Inquiry"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_tenantId_id_key" ON "Inquiry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InquiryLine_tenantId_inquiryId_seq_key" ON "InquiryLine"("tenantId", "inquiryId", "seq");

-- CreateIndex
CREATE INDEX "CustomerRequirement_tenantId_partyId_active_idx" ON "CustomerRequirement"("tenantId", "partyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerRequirement_tenantId_partyId_id_key" ON "CustomerRequirement"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "PartyHold_tenantId_partyId_releasedAt_idx" ON "PartyHold"("tenantId", "partyId", "releasedAt");

-- CreateIndex
CREATE INDEX "PartyCompanyTerms_tenantId_partyId_companyId_idx" ON "PartyCompanyTerms"("tenantId", "partyId", "companyId");

-- CreateIndex
CREATE INDEX "Season_tenantId_companyId_status_idx" ON "Season"("tenantId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Season_tenantId_companyId_code_key" ON "Season"("tenantId", "companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Season_tenantId_id_key" ON "Season"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Season_tenantId_companyId_id_key" ON "Season"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "Party_tenantId_teamPartyId_idx" ON "Party"("tenantId", "teamPartyId");

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_tenantId_teamPartyId_fkey" FOREIGN KEY ("tenantId", "teamPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_assigneeId_fkey" FOREIGN KEY ("tenantId", "assigneeId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_partyId_quoteId_fkey" FOREIGN KEY ("tenantId", "partyId", "quoteId") REFERENCES "Quote"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InquiryLine" ADD CONSTRAINT "InquiryLine_tenantId_inquiryId_fkey" FOREIGN KEY ("tenantId", "inquiryId") REFERENCES "Inquiry"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InquiryLine" ADD CONSTRAINT "InquiryLine_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InquiryLine" ADD CONSTRAINT "InquiryLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerRequirement" ADD CONSTRAINT "CustomerRequirement_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerRequirement" ADD CONSTRAINT "CustomerRequirement_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerRequirement" ADD CONSTRAINT "CustomerRequirement_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerRequirement" ADD CONSTRAINT "CustomerRequirement_tenantId_partyId_supersedesId_fkey" FOREIGN KEY ("tenantId", "partyId", "supersedesId") REFERENCES "CustomerRequirement"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyHold" ADD CONSTRAINT "PartyHold_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyHold" ADD CONSTRAINT "PartyHold_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyCompanyTerms" ADD CONSTRAINT "PartyCompanyTerms_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyCompanyTerms" ADD CONSTRAINT "PartyCompanyTerms_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyCompanyTerms" ADD CONSTRAINT "PartyCompanyTerms_tenantId_paymentTermsId_fkey" FOREIGN KEY ("tenantId", "paymentTermsId") REFERENCES "PaymentTerms"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyCompanyTerms" ADD CONSTRAINT "PartyCompanyTerms_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "PriceList"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_tenantId_seasonId_fkey" FOREIGN KEY ("tenantId", "seasonId") REFERENCES "Season"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_tenantId_companyId_seasonId_fkey" FOREIGN KEY ("tenantId", "companyId", "seasonId") REFERENCES "Season"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

