-- CreateEnum
CREATE TYPE "BankStatementFormat" AS ENUM ('CAMT053', 'CSV', 'XLSX', 'OFX');

-- CreateEnum
CREATE TYPE "BankMatchConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "BankMatchReason" AS ENUM ('AMOUNT_EQUAL', 'AMOUNT_WITHIN_TOLERANCE', 'NUMBER_IN_REFERENCE', 'IBAN_KNOWN', 'NAME_MATCHES', 'CHOSEN_BY_PERSON');

-- CreateEnum
CREATE TYPE "WriteOffKind" AS ENUM ('UNDERPAYMENT', 'OVERPAYMENT');

-- CreateEnum
CREATE TYPE "WriteOffReason" AS ENUM ('ROUNDING', 'BANK_CHARGES', 'OTHER');

-- CreateEnum
CREATE TYPE "RibaBatchStatus" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RibaItemStatus" AS ENUM ('ISSUED', 'PAID', 'UNPAID');

-- CreateEnum
CREATE TYPE "ReminderStopReason" AS ENUM ('PAYMENT_PROCESSING', 'DISPUTE', 'PROMISE_TO_PAY', 'CREDIT_PENDING');

-- CreateEnum
CREATE TYPE "PaymentProposalStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccountMappingKind" AS ENUM ('ITEM_GROUP', 'TAX_CODE', 'COST_CATEGORY', 'PAYMENT_METHOD', 'PARTY_GROUP');

-- CreateEnum
CREATE TYPE "ExportedDocumentChange" AS ENUM ('NEW', 'CHANGED');

-- CreateEnum
CREATE TYPE "IntegrityCheckResult" AS ENUM ('PASSED', 'FAILED', 'ERROR');

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "reminderTrustedLevel" INTEGER;

-- AlterTable
ALTER TABLE "PayablesSettings" ADD COLUMN     "remittanceMailOn" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReceivablesSettings" ADD COLUMN     "paymentNoticeToCustomerOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ribaOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "writeOffToleranceAmount" INTEGER;

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "holder" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "bic" TEXT,
    "bankName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "format" "BankStatementFormat" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "importedById" UUID NOT NULL,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "statementId" UUID NOT NULL,
    "bookedOn" DATE NOT NULL,
    "valueOn" DATE,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "bankReference" TEXT,
    "referenceText" TEXT,
    "counterpartyName" TEXT,
    "counterpartyIban" TEXT,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BankLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "bankLineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "invoiceIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "depositRequestIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "paymentId" UUID,
    "supplierInvoiceId" UUID,
    "confidence" "BankMatchConfidence" NOT NULL,
    "reasons" "BankMatchReason"[],
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedById" UUID,
    "reversedAt" TIMESTAMPTZ(3),
    "reversedById" UUID,
    "reverseReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BankMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWriteOff" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "allocationId" UUID,
    "kind" "WriteOffKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" "WriteOffReason" NOT NULL,
    "note" TEXT,
    "toleranceAmount" INTEGER NOT NULL,
    "reversalOfId" UUID,
    "writtenOffById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentWriteOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RibaBatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "dueFrom" DATE NOT NULL,
    "dueTo" DATE NOT NULL,
    "status" "RibaBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "fileId" UUID,
    "issuedAt" TIMESTAMPTZ(3),
    "issuedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RibaBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RibaItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "instalment" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "RibaItemStatus" NOT NULL DEFAULT 'ISSUED',
    "settledOn" DATE,
    "unpaidFee" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RibaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderStop" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "reason" "ReminderStopReason" NOT NULL,
    "until" DATE,
    "note" TEXT,
    "liftedAt" TIMESTAMPTZ(3),
    "liftedById" UUID,
    "liftReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReminderStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerStatementFigures" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "asOf" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "figures" JSONB NOT NULL,
    "fileId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CustomerStatementFigures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProposal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "PaymentProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "paidAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,

    CONSTRAINT "PaymentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProposalLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "supplierInvoiceId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "supplierBankAccountId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PaymentProposalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountMapping" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "kind" "AccountMappingKind" NOT NULL,
    "key" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "journalsOn" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AccountingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportedDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "exportId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "number" TEXT,
    "fingerprint" TEXT NOT NULL,
    "change" "ExportedDocumentChange" NOT NULL DEFAULT 'NEW',
    "changedAt" TIMESTAMPTZ(3),
    "changedFingerprint" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ExportedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrityCheckRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "checkCode" TEXT NOT NULL,
    "ranAt" TIMESTAMPTZ(3) NOT NULL,
    "result" "IntegrityCheckResult" NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "failures" JSONB NOT NULL DEFAULT '[]',
    "errorWords" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IntegrityCheckRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankAccount_tenantId_companyId_active_idx" ON "BankAccount"("tenantId", "companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_tenantId_companyId_id_key" ON "BankAccount"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "BankStatement_tenantId_bankAccountId_periodEnd_idx" ON "BankStatement"("tenantId", "bankAccountId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_tenantId_companyId_bankAccountId_id_key" ON "BankStatement"("tenantId", "companyId", "bankAccountId", "id");

-- CreateIndex
CREATE INDEX "BankLine_tenantId_statementId_idx" ON "BankLine"("tenantId", "statementId");

-- CreateIndex
CREATE INDEX "BankLine_tenantId_companyId_bookedOn_idx" ON "BankLine"("tenantId", "companyId", "bookedOn");

-- CreateIndex
CREATE UNIQUE INDEX "BankLine_tenantId_bankAccountId_fingerprint_key" ON "BankLine"("tenantId", "bankAccountId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "BankLine_tenantId_companyId_id_key" ON "BankLine"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "BankMatch_tenantId_bankLineId_idx" ON "BankMatch"("tenantId", "bankLineId");

-- CreateIndex
CREATE INDEX "BankMatch_tenantId_paymentId_idx" ON "BankMatch"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "BankMatch_tenantId_supplierInvoiceId_idx" ON "BankMatch"("tenantId", "supplierInvoiceId");

-- CreateIndex
CREATE INDEX "PaymentWriteOff_tenantId_allocationId_idx" ON "PaymentWriteOff"("tenantId", "allocationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWriteOff_tenantId_paymentId_id_key" ON "PaymentWriteOff"("tenantId", "paymentId", "id");

-- CreateIndex
CREATE INDEX "RibaBatch_tenantId_companyId_status_idx" ON "RibaBatch"("tenantId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RibaBatch_tenantId_companyId_id_key" ON "RibaBatch"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "RibaItem_tenantId_batchId_idx" ON "RibaItem"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "RibaItem_tenantId_invoiceId_idx" ON "RibaItem"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "ReminderStop_tenantId_invoiceId_idx" ON "ReminderStop"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "ReminderStop_tenantId_companyId_partyId_idx" ON "ReminderStop"("tenantId", "companyId", "partyId");

-- CreateIndex
CREATE INDEX "CustomerStatementFigures_tenantId_partyId_asOf_idx" ON "CustomerStatementFigures"("tenantId", "partyId", "asOf");

-- CreateIndex
CREATE INDEX "PaymentProposal_tenantId_companyId_weekStart_idx" ON "PaymentProposal"("tenantId", "companyId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProposal_tenantId_companyId_id_key" ON "PaymentProposal"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "PaymentProposalLine_tenantId_proposalId_idx" ON "PaymentProposalLine"("tenantId", "proposalId");

-- CreateIndex
CREATE INDEX "PaymentProposalLine_tenantId_supplierInvoiceId_idx" ON "PaymentProposalLine"("tenantId", "supplierInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_tenantId_companyId_kind_key_validFrom_key" ON "AccountMapping"("tenantId", "companyId", "kind", "key", "validFrom");

-- CreateIndex
CREATE INDEX "AccountingSettings_tenantId_companyId_idx" ON "AccountingSettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "ExportedDocument_tenantId_exportId_idx" ON "ExportedDocument"("tenantId", "exportId");

-- CreateIndex
CREATE INDEX "ExportedDocument_tenantId_companyId_recordType_recordId_idx" ON "ExportedDocument"("tenantId", "companyId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "IntegrityCheckRun_tenantId_companyId_checkCode_ranAt_idx" ON "IntegrityCheckRun"("tenantId", "companyId", "checkCode", "ranAt");

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_tenantId_companyId_bankAccountId_fkey" FOREIGN KEY ("tenantId", "companyId", "bankAccountId") REFERENCES "BankAccount"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_tenantId_companyId_bankAccountId_statementId_fkey" FOREIGN KEY ("tenantId", "companyId", "bankAccountId", "statementId") REFERENCES "BankStatement"("tenantId", "companyId", "bankAccountId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_tenantId_companyId_bankLineId_fkey" FOREIGN KEY ("tenantId", "companyId", "bankLineId") REFERENCES "BankLine"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_tenantId_companyId_partyId_paymentId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "paymentId") REFERENCES "Payment"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_tenantId_companyId_partyId_supplierInvoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "supplierInvoiceId") REFERENCES "SupplierInvoice"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentWriteOff" ADD CONSTRAINT "PaymentWriteOff_tenantId_companyId_partyId_paymentId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "paymentId") REFERENCES "Payment"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentWriteOff" ADD CONSTRAINT "PaymentWriteOff_tenantId_paymentId_allocationId_fkey" FOREIGN KEY ("tenantId", "paymentId", "allocationId") REFERENCES "PaymentAllocation"("tenantId", "paymentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentWriteOff" ADD CONSTRAINT "PaymentWriteOff_tenantId_paymentId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "paymentId", "reversalOfId") REFERENCES "PaymentWriteOff"("tenantId", "paymentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RibaBatch" ADD CONSTRAINT "RibaBatch_tenantId_companyId_bankAccountId_fkey" FOREIGN KEY ("tenantId", "companyId", "bankAccountId") REFERENCES "BankAccount"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RibaBatch" ADD CONSTRAINT "RibaBatch_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RibaItem" ADD CONSTRAINT "RibaItem_tenantId_companyId_batchId_fkey" FOREIGN KEY ("tenantId", "companyId", "batchId") REFERENCES "RibaBatch"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RibaItem" ADD CONSTRAINT "RibaItem_tenantId_companyId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "invoiceId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReminderStop" ADD CONSTRAINT "ReminderStop_tenantId_companyId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "invoiceId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerStatementFigures" ADD CONSTRAINT "CustomerStatementFigures_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerStatementFigures" ADD CONSTRAINT "CustomerStatementFigures_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerStatementFigures" ADD CONSTRAINT "CustomerStatementFigures_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentProposal" ADD CONSTRAINT "PaymentProposal_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentProposalLine" ADD CONSTRAINT "PaymentProposalLine_tenantId_companyId_proposalId_fkey" FOREIGN KEY ("tenantId", "companyId", "proposalId") REFERENCES "PaymentProposal"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentProposalLine" ADD CONSTRAINT "PaymentProposalLine_tenantId_companyId_partyId_supplierInv_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "supplierInvoiceId") REFERENCES "SupplierInvoice"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentProposalLine" ADD CONSTRAINT "PaymentProposalLine_tenantId_partyId_supplierBankAccountId_fkey" FOREIGN KEY ("tenantId", "partyId", "supplierBankAccountId") REFERENCES "SupplierBankAccount"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingSettings" ADD CONSTRAINT "AccountingSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportedDocument" ADD CONSTRAINT "ExportedDocument_tenantId_companyId_exportId_fkey" FOREIGN KEY ("tenantId", "companyId", "exportId") REFERENCES "AccountingExport"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IntegrityCheckRun" ADD CONSTRAINT "IntegrityCheckRun_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

