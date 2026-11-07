-- CreateEnum
CREATE TYPE "PortalOrderRequestSource" AS ENUM ('PICKER', 'REORDER', 'UPLOAD');

-- CreateEnum
CREATE TYPE "PortalOrderRequestStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "OrderChangeRequestKind" AS ENUM ('CHANGE', 'CANCEL');

-- CreateEnum
CREATE TYPE "OrderChangeRequestStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REFUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PaymentIntentMethod" AS ENUM ('CARD', 'SEPA_DEBIT');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('CREATED', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationProvider" ADD VALUE 'PAYMENT_FAKE';
ALTER TYPE "IntegrationProvider" ADD VALUE 'STRIPE';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'PORTAL_REQUEST';

-- AlterTable
ALTER TABLE "MeasurementProfile" ADD COLUMN     "noticeVersionId" UUID,
ADD COLUMN     "photoBackFileId" UUID,
ADD COLUMN     "photoFrontFileId" UUID,
ADD COLUMN     "photoSideFileId" UUID,
ADD COLUMN     "photosDeleteAfter" TIMESTAMPTZ(3),
ADD COLUMN     "submittedAt" TIMESTAMPTZ(3),
ADD COLUMN     "submittedViaLinkId" UUID;

-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "cancelCutoffDays" INTEGER,
ADD COLUMN     "cancelCutoffStatus" "SalesOrderStatus",
ADD COLUMN     "changeCutoffStatus" "SalesOrderStatus";

-- CreateTable
CREATE TABLE "PortalOrderRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "number" TEXT,
    "source" "PortalOrderRequestSource" NOT NULL DEFAULT 'PICKER',
    "customerRef" TEXT,
    "shipToAddressId" UUID,
    "requestedDate" DATE,
    "note" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "PortalOrderRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "refuseReason" TEXT,
    "salesOrderId" UUID,
    "quoteId" UUID,
    "withdrawnAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PortalOrderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalOrderRequestLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "styleId" UUID NOT NULL,
    "colourwayId" UUID NOT NULL,
    "sourceOrderLineId" UUID,
    "unitPriceShown" DECIMAL(18,6),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PortalOrderRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalOrderRequestSize" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PortalOrderRequestSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderChangeRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "OrderChangeRequestKind" NOT NULL,
    "reasonCode" TEXT,
    "reason" TEXT,
    "requestedDate" DATE,
    "shipToAddressId" UUID,
    "status" "OrderChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredAt" TIMESTAMPTZ(3),
    "answeredById" UUID,
    "amendmentId" UUID,
    "withdrawnAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderChangeRequestLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "size" TEXT,
    "quantityBefore" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderChangeRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "depositRequestId" UUID,
    "invoiceId" UUID,
    "method" "PaymentIntentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "providerRef" TEXT,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'CREATED',
    "failureCode" TEXT,
    "finishedAt" TIMESTAMPTZ(3),
    "paymentId" UUID,
    "linkId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalOrderRequest_tenantId_status_idx" ON "PortalOrderRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PortalOrderRequest_tenantId_partyId_status_idx" ON "PortalOrderRequest"("tenantId", "partyId", "status");

-- CreateIndex
CREATE INDEX "PortalOrderRequest_tenantId_salesOrderId_idx" ON "PortalOrderRequest"("tenantId", "salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOrderRequest_tenantId_companyId_number_key" ON "PortalOrderRequest"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOrderRequest_tenantId_partyId_id_key" ON "PortalOrderRequest"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOrderRequestLine_tenantId_requestId_seq_key" ON "PortalOrderRequestLine"("tenantId", "requestId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOrderRequestLine_tenantId_partyId_id_key" ON "PortalOrderRequestLine"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOrderRequestSize_tenantId_lineId_size_key" ON "PortalOrderRequestSize"("tenantId", "lineId", "size");

-- CreateIndex
CREATE INDEX "OrderChangeRequest_tenantId_orderId_status_idx" ON "OrderChangeRequest"("tenantId", "orderId", "status");

-- CreateIndex
CREATE INDEX "OrderChangeRequest_tenantId_status_idx" ON "OrderChangeRequest"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrderChangeRequest_tenantId_partyId_id_key" ON "OrderChangeRequest"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderChangeRequest_tenantId_amendmentId_key" ON "OrderChangeRequest"("tenantId", "amendmentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderChangeRequestLine_tenantId_requestId_orderLineId_size_key" ON "OrderChangeRequestLine"("tenantId", "requestId", "orderLineId", "size");

-- CreateIndex
CREATE INDEX "PaymentIntent_tenantId_depositRequestId_idx" ON "PaymentIntent"("tenantId", "depositRequestId");

-- CreateIndex
CREATE INDEX "PaymentIntent_tenantId_invoiceId_idx" ON "PaymentIntent"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "PaymentIntent_tenantId_status_idx" ON "PaymentIntent"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_tenantId_providerAccountId_providerRef_key" ON "PaymentIntent"("tenantId", "providerAccountId", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_tenantId_paymentId_key" ON "PaymentIntent"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "MeasurementProfile_tenantId_photosDeleteAfter_idx" ON "MeasurementProfile"("tenantId", "photosDeleteAfter");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderAmendment_tenantId_orderId_id_key" ON "SalesOrderAmendment"("tenantId", "orderId", "id");

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_partyId_submittedViaLinkId_fkey" FOREIGN KEY ("tenantId", "partyId", "submittedViaLinkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_noticeVersionId_fkey" FOREIGN KEY ("tenantId", "noticeVersionId") REFERENCES "PrivacyNotice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_photoFrontFileId_fkey" FOREIGN KEY ("tenantId", "photoFrontFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_photoSideFileId_fkey" FOREIGN KEY ("tenantId", "photoSideFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_photoBackFileId_fkey" FOREIGN KEY ("tenantId", "photoBackFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequest" ADD CONSTRAINT "PortalOrderRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequest" ADD CONSTRAINT "PortalOrderRequest_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequest" ADD CONSTRAINT "PortalOrderRequest_tenantId_partyId_shipToAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "shipToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequest" ADD CONSTRAINT "PortalOrderRequest_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequest" ADD CONSTRAINT "PortalOrderRequest_tenantId_partyId_quoteId_fkey" FOREIGN KEY ("tenantId", "partyId", "quoteId") REFERENCES "Quote"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestLine" ADD CONSTRAINT "PortalOrderRequestLine_tenantId_partyId_requestId_fkey" FOREIGN KEY ("tenantId", "partyId", "requestId") REFERENCES "PortalOrderRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestLine" ADD CONSTRAINT "PortalOrderRequestLine_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestLine" ADD CONSTRAINT "PortalOrderRequestLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestLine" ADD CONSTRAINT "PortalOrderRequestLine_tenantId_partyId_sourceOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "sourceOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestSize" ADD CONSTRAINT "PortalOrderRequestSize_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "PortalOrderRequestLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_tenantId_companyId_partyId_orderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "orderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_tenantId_partyId_shipToAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "shipToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_tenantId_orderId_amendmentId_fkey" FOREIGN KEY ("tenantId", "orderId", "amendmentId") REFERENCES "SalesOrderAmendment"("tenantId", "orderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequestLine" ADD CONSTRAINT "OrderChangeRequestLine_tenantId_partyId_requestId_fkey" FOREIGN KEY ("tenantId", "partyId", "requestId") REFERENCES "OrderChangeRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequestLine" ADD CONSTRAINT "OrderChangeRequestLine_tenantId_partyId_orderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "orderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_companyId_partyId_depositRequestId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "depositRequestId") REFERENCES "DepositRequest"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_companyId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "invoiceId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_providerAccountId_fkey" FOREIGN KEY ("tenantId", "providerAccountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_companyId_partyId_paymentId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "paymentId") REFERENCES "Payment"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

