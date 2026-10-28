-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuoteVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalesLineKind" AS ENUM ('SIZE_GRID', 'MADE_TO_MEASURE');

-- CreateEnum
CREATE TYPE "DepositKind" AS ENUM ('ACCONTO', 'CAPARRA');

-- CreateEnum
CREATE TYPE "QuoteApprovalReason" AS ENUM ('MARGIN_FLOOR', 'DISCOUNT_LIMIT', 'AMOUNT_LIMIT', 'SPECIAL_ITEM');

-- CreateEnum
CREATE TYPE "QuoteApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "QuoteAcceptanceChannel" AS ENUM ('LINK', 'OFFICE');

-- CreateEnum
CREATE TYPE "DepositFiscalDocument" AS ENUM ('TD02', 'NONE');

-- CreateEnum
CREATE TYPE "DepositRequestStatus" AS ENUM ('OPEN', 'PAID', 'WAIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "customerRef" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currentRevision" INTEGER NOT NULL DEFAULT 1,
    "lostReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "quoteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "QuoteVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "language" TEXT NOT NULL DEFAULT 'it',
    "taxMode" "PartyTaxMode" NOT NULL,
    "taxIdentityId" UUID,
    "billToAddressId" UUID,
    "shipToAddressId" UUID,
    "billTo" JSONB,
    "shipTo" JSONB,
    "validUntil" DATE,
    "firmOffer" BOOLEAN NOT NULL DEFAULT false,
    "promiseDate" DATE,
    "paymentTerms" TEXT,
    "termsText" TEXT,
    "termsVersion" TEXT,
    "depositPct" DECIMAL(7,4),
    "depositKind" "DepositKind",
    "depositAmount" INTEGER,
    "noWithdrawal" BOOLEAN NOT NULL DEFAULT false,
    "netAmount" INTEGER NOT NULL DEFAULT 0,
    "vatAmount" INTEGER NOT NULL DEFAULT 0,
    "grossAmount" INTEGER NOT NULL DEFAULT 0,
    "costAmount" INTEGER,
    "marginAmount" INTEGER,
    "marginPct" DECIMAL(9,4),
    "marginFloorPct" DECIMAL(7,4),
    "marginFloorBreached" BOOLEAN NOT NULL DEFAULT false,
    "changeNote" TEXT,
    "documentSha256" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "SalesLineKind" NOT NULL,
    "styleId" UUID NOT NULL,
    "styleRevisionId" UUID,
    "colourwayId" UUID NOT NULL,
    "measurementProfileId" UUID,
    "baseSize" TEXT,
    "description" TEXT,
    "note" TEXT,
    "quantity" INTEGER NOT NULL,
    "listUnitPrice" DECIMAL(18,6),
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "adjustmentReason" TEXT,
    "netAmount" INTEGER NOT NULL,
    "vatRatePct" DECIMAL(5,2) NOT NULL,
    "vatNature" TEXT,
    "vatAmount" INTEGER NOT NULL,
    "unitCost" DECIMAL(18,6),
    "costAmount" INTEGER,
    "marginAmount" INTEGER,
    "marginPct" DECIMAL(9,4),
    "costSnapshot" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLineSize" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "lineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18,6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteLineSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteApproval" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "reasons" "QuoteApprovalReason"[] DEFAULT ARRAY[]::"QuoteApprovalReason"[],
    "details" JSONB,
    "requestNote" TEXT,
    "status" "QuoteApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QuoteApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteAcceptance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "versionId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "channel" "QuoteAcceptanceChannel" NOT NULL,
    "linkId" UUID,
    "signerName" TEXT NOT NULL,
    "emailCheck" "LinkEmailCheck",
    "documentSha256" TEXT NOT NULL,
    "termsVersion" TEXT,
    "noWithdrawalAccepted" BOOLEAN NOT NULL DEFAULT false,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "quoteVersionId" UUID,
    "orderId" UUID,
    "kind" "DepositKind" NOT NULL,
    "depositPct" DECIMAL(7,4),
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "fiscalDocument" "DepositFiscalDocument" NOT NULL,
    "fiscalRule" TEXT NOT NULL,
    "status" "DepositRequestStatus" NOT NULL DEFAULT 'OPEN',
    "paidAt" TIMESTAMPTZ(3),
    "statusNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DepositRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "quoteVersionId" UUID,
    "customerRef" TEXT,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "orderDate" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "language" TEXT NOT NULL DEFAULT 'it',
    "taxMode" "PartyTaxMode" NOT NULL,
    "billTo" JSONB NOT NULL,
    "shipTo" JSONB NOT NULL,
    "paymentTerms" TEXT,
    "requestedDate" DATE,
    "promiseDate" DATE,
    "originalPromiseDate" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "noWithdrawal" BOOLEAN NOT NULL DEFAULT false,
    "depositRequired" BOOLEAN NOT NULL DEFAULT false,
    "netAmount" INTEGER NOT NULL DEFAULT 0,
    "vatAmount" INTEGER NOT NULL DEFAULT 0,
    "grossAmount" INTEGER NOT NULL DEFAULT 0,
    "costAmount" INTEGER,
    "reapprovalNeededAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "SalesLineKind" NOT NULL,
    "quoteLineId" UUID,
    "styleId" UUID NOT NULL,
    "styleRevisionId" UUID,
    "colourwayId" UUID NOT NULL,
    "measurementProfileId" UUID,
    "baseSize" TEXT,
    "description" TEXT,
    "note" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "vatRatePct" DECIMAL(5,2) NOT NULL,
    "vatNature" TEXT,
    "vatAmount" INTEGER NOT NULL,
    "unitCost" DECIMAL(18,6),
    "costAmount" INTEGER,
    "requestedDate" DATE,
    "promiseDate" DATE,
    "priority" INTEGER,
    "siteId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLineSize" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "lineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18,6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesOrderLineSize_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quote_tenantId_partyId_status_idx" ON "Quote"("tenantId", "partyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_tenantId_companyId_number_key" ON "Quote"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_tenantId_partyId_id_key" ON "Quote"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "QuoteVersion_tenantId_status_validUntil_idx" ON "QuoteVersion"("tenantId", "status", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_tenantId_quoteId_revision_key" ON "QuoteVersion"("tenantId", "quoteId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_tenantId_partyId_id_key" ON "QuoteVersion"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteLine_tenantId_versionId_seq_key" ON "QuoteLine"("tenantId", "versionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteLine_tenantId_partyId_id_key" ON "QuoteLine"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteLineSize_tenantId_lineId_size_key" ON "QuoteLineSize"("tenantId", "lineId", "size");

-- CreateIndex
CREATE INDEX "QuoteApproval_tenantId_versionId_idx" ON "QuoteApproval"("tenantId", "versionId");

-- CreateIndex
CREATE INDEX "QuoteApproval_tenantId_status_idx" ON "QuoteApproval"("tenantId", "status");

-- CreateIndex
CREATE INDEX "QuoteAcceptance_tenantId_versionId_idx" ON "QuoteAcceptance"("tenantId", "versionId");

-- CreateIndex
CREATE INDEX "DepositRequest_tenantId_quoteVersionId_idx" ON "DepositRequest"("tenantId", "quoteVersionId");

-- CreateIndex
CREATE INDEX "DepositRequest_tenantId_orderId_idx" ON "DepositRequest"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "DepositRequest_tenantId_status_dueDate_idx" ON "DepositRequest"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "SalesOrder_tenantId_status_promiseDate_idx" ON "SalesOrder"("tenantId", "status", "promiseDate");

-- CreateIndex
CREATE INDEX "SalesOrder_tenantId_partyId_idx" ON "SalesOrder"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "SalesOrder_tenantId_quoteVersionId_idx" ON "SalesOrder"("tenantId", "quoteVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_tenantId_companyId_number_key" ON "SalesOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_tenantId_companyId_partyId_id_key" ON "SalesOrder"("tenantId", "companyId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLine_tenantId_orderId_seq_key" ON "SalesOrderLine"("tenantId", "orderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLine_tenantId_partyId_id_key" ON "SalesOrderLine"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLineSize_tenantId_lineId_size_key" ON "SalesOrderLineSize"("tenantId", "lineId", "size");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_tenantId_partyId_quoteId_fkey" FOREIGN KEY ("tenantId", "partyId", "quoteId") REFERENCES "Quote"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_tenantId_partyId_taxIdentityId_fkey" FOREIGN KEY ("tenantId", "partyId", "taxIdentityId") REFERENCES "PartyTaxIdentity"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_tenantId_partyId_billToAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "billToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_tenantId_partyId_shipToAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "shipToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_tenantId_partyId_versionId_fkey" FOREIGN KEY ("tenantId", "partyId", "versionId") REFERENCES "QuoteVersion"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_tenantId_styleId_styleRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "styleRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_tenantId_partyId_measurementProfileId_fkey" FOREIGN KEY ("tenantId", "partyId", "measurementProfileId") REFERENCES "MeasurementProfile"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteLineSize" ADD CONSTRAINT "QuoteLineSize_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "QuoteLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteApproval" ADD CONSTRAINT "QuoteApproval_tenantId_partyId_versionId_fkey" FOREIGN KEY ("tenantId", "partyId", "versionId") REFERENCES "QuoteVersion"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteAcceptance" ADD CONSTRAINT "QuoteAcceptance_tenantId_partyId_versionId_fkey" FOREIGN KEY ("tenantId", "partyId", "versionId") REFERENCES "QuoteVersion"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QuoteAcceptance" ADD CONSTRAINT "QuoteAcceptance_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_tenantId_partyId_quoteVersionId_fkey" FOREIGN KEY ("tenantId", "partyId", "quoteVersionId") REFERENCES "QuoteVersion"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_tenantId_companyId_partyId_orderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "orderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_tenantId_partyId_quoteVersionId_fkey" FOREIGN KEY ("tenantId", "partyId", "quoteVersionId") REFERENCES "QuoteVersion"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_companyId_partyId_orderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "orderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_partyId_quoteLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "quoteLineId") REFERENCES "QuoteLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_styleId_styleRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "styleRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_partyId_measurementProfileId_fkey" FOREIGN KEY ("tenantId", "partyId", "measurementProfileId") REFERENCES "MeasurementProfile"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderLineSize" ADD CONSTRAINT "SalesOrderLineSize_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

