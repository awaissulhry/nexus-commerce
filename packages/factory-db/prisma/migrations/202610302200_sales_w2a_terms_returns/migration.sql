-- CreateEnum
CREATE TYPE "ComplaintChannel" AS ENUM ('PHONE', 'EMAIL', 'PORTAL', 'LINK', 'RETURN', 'VISIT');

-- CreateEnum
CREATE TYPE "ComplaintCategory" AS ENUM ('SAFETY', 'FUNCTION', 'COSMETIC', 'FIT');

-- CreateEnum
CREATE TYPE "ComplaintSeverity" AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PartyInvoiceTiming" AS ENUM ('PER_SHIPMENT', 'MONTHLY');

-- CreateEnum
CREATE TYPE "PriceListKind" AS ENUM ('BASE', 'CUSTOMER', 'GROUP', 'CONTRACT');

-- CreateEnum
CREATE TYPE "PriceListVersionStatus" AS ENUM ('DRAFT', 'ACTIVE');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED', 'CLOSED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnGrade" AS ENUM ('NEW', 'LIKE_NEW', 'GOOD', 'DAMAGED', 'UNUSABLE');

-- CreateEnum
CREATE TYPE "ReturnCause" AS ENUM ('OUR_DEFECT', 'TRANSIT', 'MISUSE', 'WEAR', 'NO_FAULT');

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('REPAIR', 'REMAKE', 'REPLACE', 'CREDIT_ONLY', 'RETURN_UNCHANGED', 'SCRAP');

-- CreateEnum
CREATE TYPE "ReturnGoodsOutcome" AS ENUM ('RESTOCK', 'SECOND_QUALITY', 'QUARANTINE', 'REPAIR', 'SCRAP', 'BACK_TO_CUSTOMER');

-- CreateEnum
CREATE TYPE "ParcelCondition" AS ENUM ('INTACT', 'DAMAGED', 'OPENED');

-- CreateEnum
CREATE TYPE "ReturnFreightPayer" AS ENUM ('CUSTOMER', 'COMPANY', 'BY_CAUSE');

-- CreateEnum
CREATE TYPE "RepairKind" AS ENUM ('REPAIR', 'ALTERATION');

-- CreateEnum
CREATE TYPE "RepairStage" AS ENUM ('AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED', 'SHIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SafetyCheckResult" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "SalesMilestoneKind" AS ENUM ('DEPOSIT', 'BEFORE_SHIPPING', 'ON_DELIVERY', 'ON_INVOICE');

-- CreateEnum
CREATE TYPE "SalesMilestoneStatus" AS ENUM ('OPEN', 'PAID', 'WAIVED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'REPAIR';
ALTER TYPE "NumberKind" ADD VALUE 'COMPLAINT';

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "defaultDepositPct" DECIMAL(7,4),
ADD COLUMN     "incoterm" TEXT,
ADD COLUMN     "invoiceTiming" "PartyInvoiceTiming" NOT NULL DEFAULT 'PER_SHIPMENT',
ADD COLUMN     "minimumOrderAmount" INTEGER,
ADD COLUMN     "paymentTermsId" UUID,
ADD COLUMN     "preferredCarrierCode" TEXT,
ADD COLUMN     "priceListId" UUID;

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN     "paymentTermsId" UUID,
ADD COLUMN     "priceListVersionId" UUID;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "paymentTermsId" UUID;

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN     "closeShortReason" TEXT,
ADD COLUMN     "closedShortAt" TIMESTAMPTZ(3),
ADD COLUMN     "closedShortById" UUID,
ADD COLUMN     "closedShortQuantity" INTEGER;

-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "returnConditions" TEXT,
ADD COLUMN     "returnFreightPaidBy" "ReturnFreightPayer",
ADD COLUMN     "returnGoodsDueDays" INTEGER,
ADD COLUMN     "returnRestockingFeePct" DECIMAL(7,4),
ADD COLUMN     "returnWindowDays" INTEGER;

-- CreateTable
CREATE TABLE "Complaint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "number" TEXT NOT NULL,
    "customerRef" TEXT,
    "channel" "ComplaintChannel" NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "salesOrderId" UUID,
    "shipmentId" UUID,
    "returnId" UUID,
    "styleId" UUID,
    "size" TEXT,
    "serial" TEXT,
    "batchNumber" TEXT,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'NEW',
    "category" "ComplaintCategory",
    "severity" "ComplaintSeverity",
    "ownerId" UUID,
    "answerDueOn" DATE,
    "triagedAt" TIMESTAMPTZ(3),
    "triagedById" UUID,
    "safetyRaisedAt" TIMESTAMPTZ(3),
    "safetyAcknowledgedAt" TIMESTAMPTZ(3),
    "safetyAcknowledgedById" UUID,
    "answeredAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTerms" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "method" TEXT NOT NULL,
    "instalments" JSONB NOT NULL,
    "earlyPaymentDiscountPct" DECIMAL(7,4),
    "earlyPaymentDays" INTEGER,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PaymentTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceList" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PriceListKind" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "baseListId" UUID,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "listId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "PriceListVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "validFrom" DATE,
    "validTo" DATE,
    "activatedAt" TIMESTAMPTZ(3),
    "activatedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PriceListVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID NOT NULL,
    "styleId" UUID NOT NULL,
    "colourwayId" UUID,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PriceListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnAuthorisation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "contactId" UUID,
    "customerRef" TEXT,
    "salesOrderId" UUID,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "authorisedAt" TIMESTAMPTZ(3),
    "authorisedById" UUID,
    "goodsDueBy" DATE,
    "receivedAt" TIMESTAMPTZ(3),
    "inspectedAt" TIMESTAMPTZ(3),
    "replacementOrderId" UUID,
    "ownerId" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "statusReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReturnAuthorisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "salesOrderLineId" UUID,
    "size" TEXT,
    "invoiceLineId" UUID,
    "description" TEXT NOT NULL,
    "serial" TEXT,
    "batchNumber" TEXT,
    "quantity" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonNote" TEXT,
    "unitPrice" DECIMAL(18,6),
    "discountPct" DECIMAL(7,4),
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMPTZ(3),
    "receiptId" UUID,
    "grade" "ReturnGrade",
    "cause" "ReturnCause",
    "conditionNote" TEXT,
    "inspectedAt" TIMESTAMPTZ(3),
    "inspectedById" UUID,
    "disposition" "ReturnDisposition",
    "goodsOutcome" "ReturnGoodsOutcome",
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "creditAmount" INTEGER,
    "replacementLineId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "parcels" INTEGER NOT NULL DEFAULT 1,
    "parcelCondition" "ParcelCondition" NOT NULL,
    "carrierName" TEXT,
    "trackingNumber" TEXT,
    "customerDdtNumber" TEXT,
    "customerDdtDate" DATE,
    "note" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReturnReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "RepairKind" NOT NULL DEFAULT 'REPAIR',
    "returnLineId" UUID,
    "complaintId" UUID,
    "serial" TEXT,
    "styleId" UUID,
    "colourwayId" UUID,
    "size" TEXT,
    "problem" TEXT NOT NULL,
    "stage" "RepairStage" NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMPTZ(3),
    "inboundDdtNumber" TEXT,
    "inboundDdtDate" DATE,
    "workOrderId" UUID,
    "repairedAt" TIMESTAMPTZ(3),
    "safetyCheckRequired" BOOLEAN NOT NULL DEFAULT false,
    "safetyChecklist" JSONB,
    "safetyCheckResult" "SafetyCheckResult",
    "safetyCheckedAt" TIMESTAMPTZ(3),
    "safetyCheckedById" UUID,
    "shippedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "ownerId" UUID,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RepairOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairStageEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "repairId" UUID NOT NULL,
    "fromStage" "RepairStage",
    "stage" "RepairStage" NOT NULL,
    "repairVersion" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RepairStageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderAmendment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "netAmountBefore" INTEGER NOT NULL,
    "netAmountAfter" INTEGER NOT NULL,
    "grossAmountBefore" INTEGER NOT NULL,
    "grossAmountAfter" INTEGER NOT NULL,
    "reacceptanceNeeded" BOOLEAN NOT NULL DEFAULT false,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrderAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderMilestone" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "SalesMilestoneKind" NOT NULL,
    "label" TEXT,
    "sharePct" DECIMAL(7,4),
    "amount" INTEGER NOT NULL,
    "dueDate" DATE,
    "depositRequestId" UUID,
    "status" "SalesMilestoneStatus" NOT NULL DEFAULT 'OPEN',
    "paidAt" TIMESTAMPTZ(3),
    "statusNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrderMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Complaint_tenantId_status_answerDueOn_idx" ON "Complaint"("tenantId", "status", "answerDueOn");

-- CreateIndex
CREATE INDEX "Complaint_tenantId_partyId_idx" ON "Complaint"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_tenantId_companyId_number_key" ON "Complaint"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_tenantId_partyId_id_key" ON "Complaint"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTerms_tenantId_code_key" ON "PaymentTerms"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTerms_tenantId_id_key" ON "PaymentTerms"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PriceList_tenantId_code_key" ON "PriceList"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PriceList_tenantId_id_key" ON "PriceList"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PriceListVersion_tenantId_listId_status_validFrom_idx" ON "PriceListVersion"("tenantId", "listId", "status", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListVersion_tenantId_listId_revision_key" ON "PriceListVersion"("tenantId", "listId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListVersion_tenantId_id_key" ON "PriceListVersion"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PriceListEntry_tenantId_versionId_styleId_idx" ON "PriceListEntry"("tenantId", "versionId", "styleId");

-- CreateIndex
CREATE INDEX "ReturnAuthorisation_tenantId_status_idx" ON "ReturnAuthorisation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ReturnAuthorisation_tenantId_partyId_idx" ON "ReturnAuthorisation"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnAuthorisation_tenantId_companyId_number_key" ON "ReturnAuthorisation"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnAuthorisation_tenantId_siteId_partyId_id_key" ON "ReturnAuthorisation"("tenantId", "siteId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnAuthorisation_tenantId_siteId_id_key" ON "ReturnAuthorisation"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnAuthorisation_tenantId_companyId_partyId_id_key" ON "ReturnAuthorisation"("tenantId", "companyId", "partyId", "id");

-- CreateIndex
CREATE INDEX "ReturnLine_tenantId_invoiceLineId_idx" ON "ReturnLine"("tenantId", "invoiceLineId");

-- CreateIndex
CREATE INDEX "ReturnLine_tenantId_salesOrderLineId_idx" ON "ReturnLine"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnLine_tenantId_returnId_seq_key" ON "ReturnLine"("tenantId", "returnId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnLine_tenantId_partyId_id_key" ON "ReturnLine"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "ReturnReceipt_tenantId_returnId_receivedAt_idx" ON "ReturnReceipt"("tenantId", "returnId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnReceipt_tenantId_siteId_returnId_id_key" ON "ReturnReceipt"("tenantId", "siteId", "returnId", "id");

-- CreateIndex
CREATE INDEX "RepairOrder_tenantId_stage_idx" ON "RepairOrder"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "RepairOrder_tenantId_returnLineId_idx" ON "RepairOrder"("tenantId", "returnLineId");

-- CreateIndex
CREATE INDEX "RepairOrder_tenantId_serial_idx" ON "RepairOrder"("tenantId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "RepairOrder_tenantId_companyId_number_key" ON "RepairOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "RepairOrder_tenantId_siteId_id_key" ON "RepairOrder"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "RepairStageEvent_tenantId_repairId_at_idx" ON "RepairStageEvent"("tenantId", "repairId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderAmendment_tenantId_orderId_revision_key" ON "SalesOrderAmendment"("tenantId", "orderId", "revision");

-- CreateIndex
CREATE INDEX "SalesOrderMilestone_tenantId_status_dueDate_idx" ON "SalesOrderMilestone"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderMilestone_tenantId_orderId_seq_key" ON "SalesOrderMilestone"("tenantId", "orderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderMilestone_tenantId_partyId_id_key" ON "SalesOrderMilestone"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_tenantId_buyerPartyId_id_key" ON "InvoiceLine"("tenantId", "buyerPartyId", "id");

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_companyId_partyId_returnId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "returnId") REFERENCES "ReturnAuthorisation"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_tenantId_paymentTermsId_fkey" FOREIGN KEY ("tenantId", "paymentTermsId") REFERENCES "PaymentTerms"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "PriceList"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentTerms" ADD CONSTRAINT "PaymentTerms_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_tenantId_baseListId_fkey" FOREIGN KEY ("tenantId", "baseListId") REFERENCES "PriceList"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceListVersion" ADD CONSTRAINT "PriceListVersion_tenantId_listId_fkey" FOREIGN KEY ("tenantId", "listId") REFERENCES "PriceList"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_tenantId_versionId_fkey" FOREIGN KEY ("tenantId", "versionId") REFERENCES "PriceListVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnAuthorisation" ADD CONSTRAINT "ReturnAuthorisation_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnAuthorisation" ADD CONSTRAINT "ReturnAuthorisation_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnAuthorisation" ADD CONSTRAINT "ReturnAuthorisation_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnAuthorisation" ADD CONSTRAINT "ReturnAuthorisation_tenantId_companyId_partyId_salesOrderI_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnAuthorisation" ADD CONSTRAINT "ReturnAuthorisation_tenantId_companyId_partyId_replacement_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "replacementOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_siteId_partyId_returnId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "returnId") REFERENCES "ReturnAuthorisation"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_partyId_invoiceLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceLineId") REFERENCES "InvoiceLine"("tenantId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_siteId_returnId_receiptId_fkey" FOREIGN KEY ("tenantId", "siteId", "returnId", "receiptId") REFERENCES "ReturnReceipt"("tenantId", "siteId", "returnId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_partyId_replacementLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "replacementLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnReceipt" ADD CONSTRAINT "ReturnReceipt_tenantId_siteId_returnId_fkey" FOREIGN KEY ("tenantId", "siteId", "returnId") REFERENCES "ReturnAuthorisation"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_partyId_returnLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "returnLineId") REFERENCES "ReturnLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_partyId_complaintId_fkey" FOREIGN KEY ("tenantId", "partyId", "complaintId") REFERENCES "Complaint"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairStageEvent" ADD CONSTRAINT "RepairStageEvent_tenantId_siteId_repairId_fkey" FOREIGN KEY ("tenantId", "siteId", "repairId") REFERENCES "RepairOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_tenantId_paymentTermsId_fkey" FOREIGN KEY ("tenantId", "paymentTermsId") REFERENCES "PaymentTerms"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_tenantId_priceListVersionId_fkey" FOREIGN KEY ("tenantId", "priceListVersionId") REFERENCES "PriceListVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_tenantId_paymentTermsId_fkey" FOREIGN KEY ("tenantId", "paymentTermsId") REFERENCES "PaymentTerms"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderAmendment" ADD CONSTRAINT "SalesOrderAmendment_tenantId_companyId_partyId_orderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "orderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderMilestone" ADD CONSTRAINT "SalesOrderMilestone_tenantId_companyId_partyId_orderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "orderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderMilestone" ADD CONSTRAINT "SalesOrderMilestone_tenantId_companyId_partyId_depositRequ_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "depositRequestId") REFERENCES "DepositRequest"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

