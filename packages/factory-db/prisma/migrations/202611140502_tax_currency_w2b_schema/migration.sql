-- CreateEnum
CREATE TYPE "ExchangeRateSource" AS ENUM ('ECB', 'MANUAL');

-- CreateEnum
CREATE TYPE "TaxRuleVerification" AS ENUM ('VERIFIED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "SelfInvoiceKind" AS ENUM ('TD17', 'TD18', 'TD19');

-- CreateEnum
CREATE TYPE "SelfInvoiceStatus" AS ENUM ('PENDING', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EInvoiceSimulatedOutcome" AS ENUM ('DELIVERED', 'REJECTED', 'NOT_DELIVERABLE');

-- CreateEnum
CREATE TYPE "InvoiceRunStatus" AS ENUM ('PREVIEW', 'ISSUED');

-- CreateEnum
CREATE TYPE "DepositCancelledBy" AS ENUM ('CUSTOMER', 'COMPANY');

-- CreateEnum
CREATE TYPE "DepositRefundRule" AS ENUM ('REFUND_ALL', 'KEEP_PERCENT', 'REFUND_DOUBLE');

-- CreateEnum
CREATE TYPE "DepositCancellationDocument" AS ENUM ('CREDIT_NOTE', 'NONE');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'ECB';

-- AlterEnum
ALTER TYPE "InvoiceChargeKind" ADD VALUE 'STAMP_DUTY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceDocType" ADD VALUE 'TD05';
ALTER TYPE "InvoiceDocType" ADD VALUE 'TD16';
ALTER TYPE "InvoiceDocType" ADD VALUE 'TD17';
ALTER TYPE "InvoiceDocType" ADD VALUE 'TD18';
ALTER TYPE "InvoiceDocType" ADD VALUE 'TD19';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'SELF_INVOICE';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "debitOfId" UUID,
ADD COLUMN     "declarationOfIntentId" UUID,
ADD COLUMN     "exchangeRate" DECIMAL(18,8),
ADD COLUMN     "invoiceRunId" UUID,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "rateDate" DATE,
ADD COLUMN     "totalEur" INTEGER;

-- AlterTable
ALTER TABLE "PaymentTerms" ADD COLUMN     "fromEndOfMonth" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "skipMonths" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "Currency" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "minorUnits" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Currency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rateDate" DATE NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" "ExchangeRateSource" NOT NULL,
    "overriddenById" UUID,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "country" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "natura" TEXT,
    "legalRef" TEXT,
    "accountCodeKey" TEXT,
    "ruleId" TEXT,
    "verification" "TaxRuleVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedById" UUID,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TaxCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclarationOfIntent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "protocolNumber" TEXT NOT NULL,
    "protocolDate" DATE NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "usedAmount" INTEGER NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMPTZ(3),
    "checkedById" UUID,
    "receiptFileId" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "revokeReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DeclarationOfIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StampDutyQuarter" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "quarterStart" DATE NOT NULL,
    "invoiceCount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMPTZ(3),
    "paidById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StampDutyQuarter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfInvoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "supplierInvoiceId" UUID NOT NULL,
    "kind" "SelfInvoiceKind" NOT NULL,
    "deadline" DATE NOT NULL,
    "status" "SelfInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SelfInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEInvoiceSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "liveSince" TIMESTAMPTZ(3),
    "liveSetById" UUID,
    "simulateOutcome" "EInvoiceSimulatedOutcome" NOT NULL DEFAULT 'DELIVERED',
    "taxCodesOn" BOOLEAN NOT NULL DEFAULT false,
    "stampDutyOn" BOOLEAN NOT NULL DEFAULT false,
    "declarationsOfIntentOn" BOOLEAN NOT NULL DEFAULT false,
    "selfInvoicesOn" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CompanyEInvoiceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdiArchiveCopy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "xmlFileId" UUID NOT NULL,
    "receiptFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "copiedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SdiArchiveCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "partyIds" UUID[],
    "status" "InvoiceRunStatus" NOT NULL DEFAULT 'PREVIEW',
    "issuedAt" TIMESTAMPTZ(3),
    "issuedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InvoiceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositCancellationRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "depositKind" "DepositKind" NOT NULL,
    "cancelledBy" "DepositCancelledBy" NOT NULL,
    "madeToMeasure" BOOLEAN,
    "keepPct" DECIMAL(7,4) NOT NULL,
    "refundRule" "DepositRefundRule" NOT NULL,
    "documentKind" "DepositCancellationDocument" NOT NULL,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DepositCancellationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Currency_tenantId_companyId_idx" ON "Currency"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "ExchangeRate_tenantId_quote_rateDate_idx" ON "ExchangeRate"("tenantId", "quote", "rateDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_tenantId_key_key" ON "ExchangeRate"("tenantId", "key");

-- CreateIndex
CREATE INDEX "TaxCode_tenantId_companyId_country_code_idx" ON "TaxCode"("tenantId", "companyId", "country", "code");

-- CreateIndex
CREATE INDEX "DeclarationOfIntent_tenantId_partyId_year_idx" ON "DeclarationOfIntent"("tenantId", "partyId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarationOfIntent_tenantId_companyId_partyId_id_key" ON "DeclarationOfIntent"("tenantId", "companyId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StampDutyQuarter_tenantId_companyId_quarterStart_key" ON "StampDutyQuarter"("tenantId", "companyId", "quarterStart");

-- CreateIndex
CREATE INDEX "SelfInvoice_tenantId_companyId_status_deadline_idx" ON "SelfInvoice"("tenantId", "companyId", "status", "deadline");

-- CreateIndex
CREATE INDEX "SelfInvoice_tenantId_supplierInvoiceId_idx" ON "SelfInvoice"("tenantId", "supplierInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SelfInvoice_tenantId_invoiceId_key" ON "SelfInvoice"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "CompanyEInvoiceSettings_tenantId_companyId_idx" ON "CompanyEInvoiceSettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "SdiArchiveCopy_tenantId_invoiceId_idx" ON "SdiArchiveCopy"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SdiArchiveCopy_tenantId_key_key" ON "SdiArchiveCopy"("tenantId", "key");

-- CreateIndex
CREATE INDEX "InvoiceRun_tenantId_companyId_month_idx" ON "InvoiceRun"("tenantId", "companyId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRun_tenantId_companyId_id_key" ON "InvoiceRun"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "DepositCancellationRule_tenantId_companyId_idx" ON "DepositCancellationRule"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_invoiceRunId_idx" ON "Invoice"("tenantId", "invoiceRunId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_declarationOfIntentId_idx" ON "Invoice"("tenantId", "declarationOfIntentId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_debitOfId_idx" ON "Invoice"("tenantId", "debitOfId");

-- AddForeignKey
ALTER TABLE "Currency" ADD CONSTRAINT "Currency_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_invoiceRunId_fkey" FOREIGN KEY ("tenantId", "companyId", "invoiceRunId") REFERENCES "InvoiceRun"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_buyerPartyId_declarationOfInten_fkey" FOREIGN KEY ("tenantId", "companyId", "buyerPartyId", "declarationOfIntentId") REFERENCES "DeclarationOfIntent"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_buyerPartyId_debitOfId_fkey" FOREIGN KEY ("tenantId", "companyId", "buyerPartyId", "debitOfId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TaxCode" ADD CONSTRAINT "TaxCode_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeclarationOfIntent" ADD CONSTRAINT "DeclarationOfIntent_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeclarationOfIntent" ADD CONSTRAINT "DeclarationOfIntent_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeclarationOfIntent" ADD CONSTRAINT "DeclarationOfIntent_tenantId_receiptFileId_fkey" FOREIGN KEY ("tenantId", "receiptFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StampDutyQuarter" ADD CONSTRAINT "StampDutyQuarter_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SelfInvoice" ADD CONSTRAINT "SelfInvoice_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SelfInvoice" ADD CONSTRAINT "SelfInvoice_tenantId_companyId_partyId_supplierInvoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "supplierInvoiceId") REFERENCES "SupplierInvoice"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SelfInvoice" ADD CONSTRAINT "SelfInvoice_tenantId_companyId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "invoiceId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CompanyEInvoiceSettings" ADD CONSTRAINT "CompanyEInvoiceSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiArchiveCopy" ADD CONSTRAINT "SdiArchiveCopy_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiArchiveCopy" ADD CONSTRAINT "SdiArchiveCopy_tenantId_partyId_invoiceId_submissionId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceId", "submissionId") REFERENCES "SdiSubmission"("tenantId", "partyId", "invoiceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiArchiveCopy" ADD CONSTRAINT "SdiArchiveCopy_tenantId_xmlFileId_fkey" FOREIGN KEY ("tenantId", "xmlFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceRun" ADD CONSTRAINT "InvoiceRun_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DepositCancellationRule" ADD CONSTRAINT "DepositCancellationRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

