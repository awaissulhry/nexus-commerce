-- CreateEnum
CREATE TYPE "AccountingPackage" AS ENUM ('SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS', 'INTRASTAT', 'YEAR_END_STOCK');

-- CreateEnum
CREATE TYPE "AccountingExportStatus" AS ENUM ('DRAFT', 'EXPORTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PeriodLockLevel" AS ENUM ('SOFT', 'HARD');

-- CreateEnum
CREATE TYPE "PeriodLockStatus" AS ENUM ('LOCKED', 'UNLOCKED');

-- CreateEnum
CREATE TYPE "StandardCostStatus" AS ENUM ('DRAFT', 'FROZEN');

-- CreateEnum
CREATE TYPE "StandardCostSource" AS ENUM ('ROLLUP', 'PURCHASE', 'MANUAL');

-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('UNDECIDED', 'STANDARD', 'MOVING_AVERAGE', 'FIFO');

-- CreateEnum
CREATE TYPE "WorkOrderCostKind" AS ENUM ('MATERIAL', 'SCRAP', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'COMPLETION', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InvoiceChargeKind" AS ENUM ('FREIGHT', 'PACKAGING', 'SAMPLES', 'FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "SupplierInvoiceSource" AS ENUM ('SDI', 'EMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "SupplierInvoiceKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('RECEIVED', 'APPROVED', 'PAID', 'DISPUTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "SupplierInvoiceMatchStatus" AS ENUM ('PENDING', 'MATCHED', 'DIFFERENCES', 'NO_PO', 'WAITING_GOODS');

-- CreateEnum
CREATE TYPE "SupplierInvoiceLineKind" AS ENUM ('GOODS', 'SUBCONTRACT', 'SERVICE', 'CHARGE');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('DUE', 'PAID', 'CANCELLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ReminderAction" AS ENUM ('EMAIL', 'LETTER', 'CALL');

-- CreateEnum
CREATE TYPE "PaymentReminderStatus" AS ENUM ('PREPARED', 'APPROVED', 'SENT', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LateInterestMode" AS ENUM ('UNDECIDED', 'NONE', 'STATUTORY', 'AGREED');

-- AlterEnum
ALTER TYPE "InvoiceLineKind" ADD VALUE 'CHARGE';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'ACCOUNTING_EXPORT';

-- AlterTable
ALTER TABLE "CostingSettings" ADD COLUMN     "costingMethod" "CostingMethod" NOT NULL DEFAULT 'UNDECIDED',
ADD COLUMN     "methodLockedAt" TIMESTAMPTZ(3),
ADD COLUMN     "methodLockedById" UUID;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "chargeKind" "InvoiceChargeKind",
ADD COLUMN     "milestoneId" UUID,
ADD COLUMN     "returnLineId" UUID;

-- CreateTable
CREATE TABLE "AccountingExport" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "numberSeriesId" UUID,
    "number" TEXT,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "packages" "AccountingPackage"[],
    "layout" TEXT NOT NULL DEFAULT 'DEFAULT',
    "supersedesId" UUID,
    "status" "AccountingExportStatus" NOT NULL DEFAULT 'DRAFT',
    "checks" JSONB NOT NULL DEFAULT '[]',
    "manifest" JSONB NOT NULL DEFAULT '[]',
    "exportedAt" TIMESTAMPTZ(3),
    "exportedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AccountingExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingExportFile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "exportId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "package" "AccountingPackage" NOT NULL,
    "fileId" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AccountingExportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodLock" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "level" "PeriodLockLevel" NOT NULL,
    "status" "PeriodLockStatus" NOT NULL DEFAULT 'LOCKED',
    "exportId" UUID,
    "lockedAt" TIMESTAMPTZ(3) NOT NULL,
    "lockedById" UUID NOT NULL,
    "note" TEXT,
    "unlockedAt" TIMESTAMPTZ(3),
    "unlockedById" UUID,
    "unlockReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PeriodLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandardCost" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "status" "StandardCostStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "StandardCostSource" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "materialCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "labourCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "subcontractCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "overheadCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "labourMinutes" DECIMAL(18,4),
    "breakdown" JSONB,
    "note" TEXT,
    "frozenAt" TIMESTAMPTZ(3),
    "frozenById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StandardCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderCostEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "kind" "WorkOrderCostKind" NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "itemId" UUID,
    "quantity" DECIMAL(18,4),
    "minutes" DECIMAL(18,4),
    "unitCost" DECIMAL(18,6),
    "standardUnitCost" DECIMAL(18,6),
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "costingMethod" "CostingMethod" NOT NULL,
    "standardCostId" UUID,
    "stockMoveId" UUID,
    "operationScanId" UUID,
    "subcontractOrderId" UUID,
    "supplierInvoiceLineId" UUID,
    "sourceType" TEXT,
    "sourceId" UUID,
    "reversalOfId" UUID,
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderCostEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "source" "SupplierInvoiceSource" NOT NULL,
    "kind" "SupplierInvoiceKind" NOT NULL DEFAULT 'INVOICE',
    "docType" TEXT,
    "number" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "receivedOn" DATE NOT NULL,
    "sdiIdentifier" TEXT,
    "sdiFileName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "netTotal" INTEGER NOT NULL DEFAULT 0,
    "vatTotal" INTEGER NOT NULL DEFAULT 0,
    "grossTotal" INTEGER NOT NULL DEFAULT 0,
    "withholdingAmount" INTEGER,
    "stampDutyAmount" INTEGER,
    "vatSummary" JSONB NOT NULL DEFAULT '[]',
    "paymentTerms" JSONB,
    "dueDate" DATE,
    "creditOfId" UUID,
    "xmlFileId" UUID,
    "pdfFileId" UUID,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
    "matchStatus" "SupplierInvoiceMatchStatus" NOT NULL DEFAULT 'PENDING',
    "matchedAt" TIMESTAMPTZ(3),
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "approvalNote" TEXT,
    "disputedAt" TIMESTAMPTZ(3),
    "disputedById" UUID,
    "disputeReason" TEXT,
    "paidOn" DATE,
    "paymentRef" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "SupplierInvoiceLineKind" NOT NULL DEFAULT 'GOODS',
    "description" TEXT NOT NULL,
    "itemCode" TEXT,
    "quantity" DECIMAL(18,4),
    "uom" TEXT,
    "unitPrice" DECIMAL(18,6),
    "discountPct" DECIMAL(7,4),
    "netAmount" INTEGER NOT NULL,
    "vatRatePct" DECIMAL(5,2) NOT NULL,
    "vatNature" TEXT,
    "siteId" UUID,
    "purchaseOrderLineId" UUID,
    "subcontractOrderId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceMatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "invoiceLineId" UUID NOT NULL,
    "purchaseOrderLineId" UUID,
    "goodsReceiptLineId" UUID,
    "subcontractOrderId" UUID,
    "invoicedQuantity" DECIMAL(18,4) NOT NULL,
    "receivedQuantity" DECIMAL(18,4) NOT NULL,
    "orderedUnitPrice" DECIMAL(18,6) NOT NULL,
    "invoicedUnitPrice" DECIMAL(18,6) NOT NULL,
    "differenceAmount" INTEGER NOT NULL,
    "quantityTolerancePct" DECIMAL(7,4) NOT NULL,
    "priceTolerancePct" DECIMAL(7,4) NOT NULL,
    "withinTolerance" BOOLEAN NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedById" UUID,
    "acceptNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierInvoiceMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "creditNoteId" UUID,
    "paymentId" UUID,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "dueDate" DATE,
    "status" "RefundStatus" NOT NULL DEFAULT 'DUE',
    "paidOn" DATE,
    "externalRef" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "paidById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReminder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "action" "ReminderAction" NOT NULL,
    "invoiceIds" UUID[],
    "amountDue" INTEGER NOT NULL,
    "interestAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "oldestDueDate" DATE NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'it',
    "subject" TEXT,
    "body" TEXT,
    "status" "PaymentReminderStatus" NOT NULL DEFAULT 'PREPARED',
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "sentAt" TIMESTAMPTZ(3),
    "callNote" TEXT,
    "skippedAt" TIMESTAMPTZ(3),
    "skippedById" UUID,
    "skipReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PaymentReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivablesSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ladder" JSONB NOT NULL DEFAULT '[]',
    "lateInterestMode" "LateInterestMode" NOT NULL DEFAULT 'UNDECIDED',
    "lateInterestAgreedPct" DECIMAL(7,4),
    "recoveryChargeAmount" INTEGER,
    "minimumAmount" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReceivablesSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountingExport_tenantId_companyId_periodStart_idx" ON "AccountingExport"("tenantId", "companyId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExport_tenantId_companyId_number_key" ON "AccountingExport"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExport_tenantId_id_key" ON "AccountingExport"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExport_tenantId_companyId_id_key" ON "AccountingExport"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExportFile_tenantId_exportId_seq_key" ON "AccountingExportFile"("tenantId", "exportId", "seq");

-- CreateIndex
CREATE INDEX "PeriodLock_tenantId_companyId_status_idx" ON "PeriodLock"("tenantId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodLock_tenantId_companyId_periodStart_periodEnd_key" ON "PeriodLock"("tenantId", "companyId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "StandardCost_tenantId_itemId_status_idx" ON "StandardCost"("tenantId", "itemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StandardCost_tenantId_companyId_itemId_validFrom_key" ON "StandardCost"("tenantId", "companyId", "itemId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "StandardCost_tenantId_companyId_id_key" ON "StandardCost"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "WorkOrderCostEntry_tenantId_workOrderId_occurredAt_idx" ON "WorkOrderCostEntry"("tenantId", "workOrderId", "occurredAt");

-- CreateIndex
CREATE INDEX "WorkOrderCostEntry_tenantId_companyId_occurredAt_idx" ON "WorkOrderCostEntry"("tenantId", "companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "WorkOrderCostEntry_tenantId_stockMoveId_idx" ON "WorkOrderCostEntry"("tenantId", "stockMoveId");

-- CreateIndex
CREATE INDEX "WorkOrderCostEntry_tenantId_operationScanId_idx" ON "WorkOrderCostEntry"("tenantId", "operationScanId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderCostEntry_tenantId_idempotencyKey_key" ON "WorkOrderCostEntry"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderCostEntry_tenantId_workOrderId_id_key" ON "WorkOrderCostEntry"("tenantId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "SupplierInvoice_tenantId_companyId_status_idx" ON "SupplierInvoice"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "SupplierInvoice_tenantId_partyId_issueDate_idx" ON "SupplierInvoice"("tenantId", "partyId", "issueDate");

-- CreateIndex
CREATE INDEX "SupplierInvoice_tenantId_dueDate_idx" ON "SupplierInvoice"("tenantId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_sdiIdentifier_key" ON "SupplierInvoice"("tenantId", "sdiIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_companyId_partyId_number_issueDate_key" ON "SupplierInvoice"("tenantId", "companyId", "partyId", "number", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_partyId_id_key" ON "SupplierInvoice"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_companyId_partyId_id_key" ON "SupplierInvoice"("tenantId", "companyId", "partyId", "id");

-- CreateIndex
CREATE INDEX "SupplierInvoiceLine_tenantId_purchaseOrderLineId_idx" ON "SupplierInvoiceLine"("tenantId", "purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceLine_tenantId_subcontractOrderId_idx" ON "SupplierInvoiceLine"("tenantId", "subcontractOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceLine_tenantId_invoiceId_seq_key" ON "SupplierInvoiceLine"("tenantId", "invoiceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceLine_tenantId_partyId_id_key" ON "SupplierInvoiceLine"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceLine_tenantId_id_key" ON "SupplierInvoiceLine"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SupplierInvoiceMatch_tenantId_invoiceId_idx" ON "SupplierInvoiceMatch"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceMatch_tenantId_invoiceLineId_idx" ON "SupplierInvoiceMatch"("tenantId", "invoiceLineId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceMatch_tenantId_goodsReceiptLineId_idx" ON "SupplierInvoiceMatch"("tenantId", "goodsReceiptLineId");

-- CreateIndex
CREATE INDEX "Refund_tenantId_partyId_status_idx" ON "Refund"("tenantId", "partyId", "status");

-- CreateIndex
CREATE INDEX "Refund_tenantId_creditNoteId_idx" ON "Refund"("tenantId", "creditNoteId");

-- CreateIndex
CREATE INDEX "Refund_tenantId_paymentId_idx" ON "Refund"("tenantId", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_companyId_externalRef_key" ON "Refund"("tenantId", "companyId", "externalRef");

-- CreateIndex
CREATE INDEX "PaymentReminder_tenantId_companyId_status_idx" ON "PaymentReminder"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "PaymentReminder_tenantId_partyId_level_idx" ON "PaymentReminder"("tenantId", "partyId", "level");

-- CreateIndex
CREATE INDEX "ReceivablesSettings_tenantId_companyId_idx" ON "ReceivablesSettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_returnLineId_idx" ON "InvoiceLine"("tenantId", "returnLineId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_milestoneId_idx" ON "InvoiceLine"("tenantId", "milestoneId");

-- AddForeignKey
ALTER TABLE "AccountingExport" ADD CONSTRAINT "AccountingExport_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingExport" ADD CONSTRAINT "AccountingExport_tenantId_companyId_numberSeriesId_fkey" FOREIGN KEY ("tenantId", "companyId", "numberSeriesId") REFERENCES "NumberSeries"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingExport" ADD CONSTRAINT "AccountingExport_tenantId_companyId_supersedesId_fkey" FOREIGN KEY ("tenantId", "companyId", "supersedesId") REFERENCES "AccountingExport"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingExportFile" ADD CONSTRAINT "AccountingExportFile_tenantId_exportId_fkey" FOREIGN KEY ("tenantId", "exportId") REFERENCES "AccountingExport"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountingExportFile" ADD CONSTRAINT "AccountingExportFile_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PeriodLock" ADD CONSTRAINT "PeriodLock_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PeriodLock" ADD CONSTRAINT "PeriodLock_tenantId_companyId_exportId_fkey" FOREIGN KEY ("tenantId", "companyId", "exportId") REFERENCES "AccountingExport"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StandardCost" ADD CONSTRAINT "StandardCost_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StandardCost" ADD CONSTRAINT "StandardCost_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_companyId_standardCostId_fkey" FOREIGN KEY ("tenantId", "companyId", "standardCostId") REFERENCES "StandardCost"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_siteId_stockMoveId_fkey" FOREIGN KEY ("tenantId", "siteId", "stockMoveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_siteId_operationScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "operationScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_siteId_workOrderId_subcontract_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_supplierInvoiceLineId_fkey" FOREIGN KEY ("tenantId", "supplierInvoiceLineId") REFERENCES "SupplierInvoiceLine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderCostEntry" ADD CONSTRAINT "WorkOrderCostEntry_tenantId_workOrderId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "workOrderId", "reversalOfId") REFERENCES "WorkOrderCostEntry"("tenantId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_buyerPartyId_returnLineId_fkey" FOREIGN KEY ("tenantId", "buyerPartyId", "returnLineId") REFERENCES "ReturnLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_buyerPartyId_milestoneId_fkey" FOREIGN KEY ("tenantId", "buyerPartyId", "milestoneId") REFERENCES "SalesOrderMilestone"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_companyId_partyId_creditOfId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "creditOfId") REFERENCES "SupplierInvoice"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_xmlFileId_fkey" FOREIGN KEY ("tenantId", "xmlFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_pdfFileId_fkey" FOREIGN KEY ("tenantId", "pdfFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_tenantId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceId") REFERENCES "SupplierInvoice"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_tenantId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_tenantId_siteId_partyId_subcontractOrd_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceMatch" ADD CONSTRAINT "SupplierInvoiceMatch_tenantId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceId") REFERENCES "SupplierInvoice"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceMatch" ADD CONSTRAINT "SupplierInvoiceMatch_tenantId_partyId_invoiceLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceLineId") REFERENCES "SupplierInvoiceLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceMatch" ADD CONSTRAINT "SupplierInvoiceMatch_tenantId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceMatch" ADD CONSTRAINT "SupplierInvoiceMatch_tenantId_siteId_goodsReceiptLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "goodsReceiptLineId") REFERENCES "GoodsReceiptLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceMatch" ADD CONSTRAINT "SupplierInvoiceMatch_tenantId_siteId_partyId_subcontractOr_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_companyId_partyId_creditNoteId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "creditNoteId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_companyId_partyId_paymentId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "paymentId") REFERENCES "Payment"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentReminder" ADD CONSTRAINT "PaymentReminder_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentReminder" ADD CONSTRAINT "PaymentReminder_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReceivablesSettings" ADD CONSTRAINT "ReceivablesSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

