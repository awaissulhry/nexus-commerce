-- CreateEnum
CREATE TYPE "InvoiceDocType" AS ENUM ('TD01', 'TD02', 'TD04', 'TD24');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "InvoicePriceBasis" AS ENUM ('NET', 'GROSS');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('GOODS', 'SERVICE', 'DEPOSIT_DEDUCTION');

-- CreateEnum
CREATE TYPE "SdiSubmissionStatus" AS ENUM ('SENDING', 'SENT', 'FAILED', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED');

-- CreateEnum
CREATE TYPE "SdiNotificationType" AS ENUM ('RC', 'MC', 'NS', 'NE', 'DT', 'AT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECEIVED', 'VOIDED');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "buyerPartyId" UUID NOT NULL,
    "partyId" UUID,
    "docType" "InvoiceDocType" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "numberSeriesId" UUID,
    "number" TEXT,
    "year" INTEGER,
    "issueDate" DATE,
    "issuedAt" TIMESTAMPTZ(3),
    "issuedById" UUID,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "priceBasis" "InvoicePriceBasis" NOT NULL DEFAULT 'NET',
    "seller" JSONB,
    "billTo" JSONB NOT NULL,
    "netTotal" INTEGER NOT NULL DEFAULT 0,
    "vatTotal" INTEGER NOT NULL DEFAULT 0,
    "grossTotal" INTEGER NOT NULL DEFAULT 0,
    "vatSummary" JSONB NOT NULL DEFAULT '[]',
    "stampDutyAmount" INTEGER,
    "paymentTerms" JSONB,
    "causale" TEXT,
    "documentRefs" JSONB,
    "salesOrderId" UUID,
    "depositRequestId" UUID,
    "creditOfId" UUID,
    "xmlFileId" UUID,
    "pdfFileId" UUID,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "invoiceId" UUID NOT NULL,
    "buyerPartyId" UUID NOT NULL,
    "partyId" UUID,
    "seq" INTEGER NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL DEFAULT 'GOODS',
    "description" TEXT NOT NULL,
    "itemCode" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "discountPct" DECIMAL(7,4),
    "netAmount" INTEGER NOT NULL,
    "grossAmount" INTEGER,
    "vatRatePct" DECIMAL(5,2) NOT NULL,
    "vatNature" TEXT,
    "vatLegalRef" TEXT,
    "salesOrderLineId" UUID,
    "size" TEXT,
    "ddtId" UUID,
    "depositInvoiceId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdiSubmission" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "integrationAccountId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "xmlFileId" UUID NOT NULL,
    "status" "SdiSubmissionStatus" NOT NULL DEFAULT 'SENDING',
    "providerRef" TEXT,
    "sdiIdentifier" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "outcomeAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SdiSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdiNotification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "type" "SdiNotificationType" NOT NULL,
    "sdiMessageId" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "inboundWebhookId" UUID,
    "createdById" UUID,

    CONSTRAINT "SdiNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "receivedOn" DATE NOT NULL,
    "externalRef" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECEIVED',
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID,
    "depositRequestId" UUID,
    "amount" INTEGER NOT NULL,
    "reversalOfId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_tenantId_status_idx" ON "Invoice"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_partyId_idx" ON "Invoice"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_companyId_year_idx" ON "Invoice"("tenantId", "companyId", "year");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_salesOrderId_idx" ON "Invoice"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_depositRequestId_idx" ON "Invoice"("tenantId", "depositRequestId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_creditOfId_idx" ON "Invoice"("tenantId", "creditOfId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_numberSeriesId_number_key" ON "Invoice"("tenantId", "numberSeriesId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_buyerPartyId_id_key" ON "Invoice"("tenantId", "buyerPartyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_companyId_buyerPartyId_id_key" ON "Invoice"("tenantId", "companyId", "buyerPartyId", "id");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_partyId_idx" ON "InvoiceLine"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_salesOrderLineId_idx" ON "InvoiceLine"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_ddtId_idx" ON "InvoiceLine"("tenantId", "ddtId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_depositInvoiceId_idx" ON "InvoiceLine"("tenantId", "depositInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_tenantId_invoiceId_seq_key" ON "InvoiceLine"("tenantId", "invoiceId", "seq");

-- CreateIndex
CREATE INDEX "SdiSubmission_tenantId_status_idx" ON "SdiSubmission"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SdiSubmission_tenantId_invoiceId_attempt_key" ON "SdiSubmission"("tenantId", "invoiceId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "SdiSubmission_tenantId_fileName_key" ON "SdiSubmission"("tenantId", "fileName");

-- CreateIndex
CREATE UNIQUE INDEX "SdiSubmission_tenantId_partyId_invoiceId_id_key" ON "SdiSubmission"("tenantId", "partyId", "invoiceId", "id");

-- CreateIndex
CREATE INDEX "SdiNotification_tenantId_invoiceId_receivedAt_idx" ON "SdiNotification"("tenantId", "invoiceId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SdiNotification_tenantId_submissionId_sdiMessageId_key" ON "SdiNotification"("tenantId", "submissionId", "sdiMessageId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_partyId_receivedOn_idx" ON "Payment"("tenantId", "partyId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_companyId_externalRef_key" ON "Payment"("tenantId", "companyId", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_companyId_partyId_id_key" ON "Payment"("tenantId", "companyId", "partyId", "id");

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_invoiceId_idx" ON "PaymentAllocation"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_depositRequestId_idx" ON "PaymentAllocation"("tenantId", "depositRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_tenantId_paymentId_id_key" ON "PaymentAllocation"("tenantId", "paymentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Ddt_tenantId_partyId_id_key" ON "Ddt"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DepositRequest_tenantId_companyId_partyId_id_key" ON "DepositRequest"("tenantId", "companyId", "partyId", "id");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_buyerPartyId_fkey" FOREIGN KEY ("tenantId", "buyerPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_numberSeriesId_fkey" FOREIGN KEY ("tenantId", "companyId", "numberSeriesId") REFERENCES "NumberSeries"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_buyerPartyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "buyerPartyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_buyerPartyId_depositRequestId_fkey" FOREIGN KEY ("tenantId", "companyId", "buyerPartyId", "depositRequestId") REFERENCES "DepositRequest"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_companyId_buyerPartyId_creditOfId_fkey" FOREIGN KEY ("tenantId", "companyId", "buyerPartyId", "creditOfId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_xmlFileId_fkey" FOREIGN KEY ("tenantId", "xmlFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_pdfFileId_fkey" FOREIGN KEY ("tenantId", "pdfFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_buyerPartyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "buyerPartyId", "invoiceId") REFERENCES "Invoice"("tenantId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_buyerPartyId_depositInvoiceId_fkey" FOREIGN KEY ("tenantId", "buyerPartyId", "depositInvoiceId") REFERENCES "Invoice"("tenantId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_buyerPartyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "buyerPartyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_buyerPartyId_ddtId_fkey" FOREIGN KEY ("tenantId", "buyerPartyId", "ddtId") REFERENCES "Ddt"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiSubmission" ADD CONSTRAINT "SdiSubmission_tenantId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceId") REFERENCES "Invoice"("tenantId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiSubmission" ADD CONSTRAINT "SdiSubmission_tenantId_integrationAccountId_fkey" FOREIGN KEY ("tenantId", "integrationAccountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiSubmission" ADD CONSTRAINT "SdiSubmission_tenantId_xmlFileId_fkey" FOREIGN KEY ("tenantId", "xmlFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiNotification" ADD CONSTRAINT "SdiNotification_tenantId_partyId_invoiceId_submissionId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceId", "submissionId") REFERENCES "SdiSubmission"("tenantId", "partyId", "invoiceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_companyId_partyId_paymentId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "paymentId") REFERENCES "Payment"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_companyId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "invoiceId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_companyId_partyId_depositReques_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "depositRequestId") REFERENCES "DepositRequest"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_paymentId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "paymentId", "reversalOfId") REFERENCES "PaymentAllocation"("tenantId", "paymentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

