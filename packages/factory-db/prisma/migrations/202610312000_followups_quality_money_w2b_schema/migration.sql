-- CreateEnum
CREATE TYPE "CertificateRenewalStatus" AS ENUM ('STARTED', 'APPLIED', 'RENEWED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayablesBillingBasis" AS ENUM ('RECEIVED', 'ORDERED');

-- CreateEnum
CREATE TYPE "PayablesSdiApproval" AS ENUM ('ANY_APPROVER', 'NOT_THE_BUYER', 'LISTED');

-- CreateEnum
CREATE TYPE "SdiInboxProblem" AS ENUM ('UNREADABLE', 'SUPPLIER_UNKNOWN', 'OTHER_ADDRESSEE', 'DUPLICATE_NUMBER', 'PERIOD_LOCKED', 'FILE_UNAVAILABLE', 'OTHER');

-- CreateEnum
CREATE TYPE "SdiInboxStatus" AS ENUM ('OPEN', 'RECORDED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('RETURN', 'PRICE_ADJUSTMENT', 'DEPOSIT_BACK', 'OVERPAYMENT', 'OTHER');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'HOLD';

-- DropIndex
DROP INDEX "SupplierInvoice_tenantId_companyId_partyId_number_issueDate_key";

-- DropIndex
DROP INDEX "SupplierInvoice_tenantId_sdiIdentifier_key";

-- AlterTable
ALTER TABLE "CostingSettings" ADD COLUMN     "overheadFromTenant" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "dueAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "NcrContainmentAction" ADD COLUMN     "cancelReason" TEXT;

-- AlterTable
ALTER TABLE "PaymentAllocation" ADD COLUMN     "carriedFromId" UUID;

-- AlterTable
ALTER TABLE "QualityHold" ADD COLUMN     "number" TEXT;

-- AlterTable
ALTER TABLE "QualitySettings" ADD COLUMN     "defaultContainmentHours" INTEGER,
ADD COLUMN     "placerMayRelease" BOOLEAN;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "reasonCode" "RefundReason";

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "claimId" UUID,
ADD COLUMN     "claimSiteId" UUID,
ADD COLUMN     "sdiBodyIndex" INTEGER,
ADD COLUMN     "sdiFileId" UUID;

-- CreateTable
CREATE TABLE "CertificateRenewal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "certificateId" UUID NOT NULL,
    "status" "CertificateRenewalStatus" NOT NULL DEFAULT 'STARTED',
    "windowOpensOn" DATE NOT NULL,
    "windowClosesOn" DATE NOT NULL,
    "taskId" UUID,
    "language" TEXT NOT NULL DEFAULT 'it',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedById" UUID,
    "appliedOn" DATE,
    "applicationReference" TEXT,
    "applicationNote" TEXT,
    "appliedInWindow" BOOLEAN,
    "appliedAt" TIMESTAMPTZ(3),
    "appliedById" UUID,
    "newCertificateId" UUID,
    "renewedAt" TIMESTAMPTZ(3),
    "renewedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CertificateRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayablesSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "quantityTolerancePct" DECIMAL(7,4),
    "priceTolerancePct" DECIMAL(7,4),
    "differenceToleranceAmount" INTEGER,
    "billingBasis" "PayablesBillingBasis",
    "sdiApproval" "PayablesSdiApproval",
    "sdiApproverIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "accepterMayNotApprove" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PayablesSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceFile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "sdiIdentifier" TEXT NOT NULL,
    "sdiFileName" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "invoiceCount" INTEGER NOT NULL,
    "xmlFileId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierInvoiceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdiInboxItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "providerRef" TEXT NOT NULL,
    "sdiIdentifier" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "problem" "SdiInboxProblem" NOT NULL,
    "problemText" TEXT NOT NULL,
    "xmlFileId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastTriedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "SdiInboxStatus" NOT NULL DEFAULT 'OPEN',
    "recordedAt" TIMESTAMPTZ(3),
    "supplierInvoiceId" UUID,
    "supplierInvoiceFileId" UUID,
    "dismissedAt" TIMESTAMPTZ(3),
    "dismissedById" UUID,
    "dismissReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SdiInboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterestReferenceRate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "halfYearStart" DATE NOT NULL,
    "referenceRatePct" DECIMAL(7,4) NOT NULL,
    "addedPointsPct" DECIMAL(7,4) NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InterestReferenceRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasingSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "confirmationRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchasingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CertificateRenewal_tenantId_certificateId_status_idx" ON "CertificateRenewal"("tenantId", "certificateId", "status");

-- CreateIndex
CREATE INDEX "CertificateRenewal_tenantId_newCertificateId_idx" ON "CertificateRenewal"("tenantId", "newCertificateId");

-- CreateIndex
CREATE INDEX "PayablesSettings_tenantId_companyId_idx" ON "PayablesSettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceFile_tenantId_partyId_receivedOn_idx" ON "SupplierInvoiceFile"("tenantId", "partyId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceFile_tenantId_sdiIdentifier_key" ON "SupplierInvoiceFile"("tenantId", "sdiIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceFile_tenantId_companyId_partyId_id_key" ON "SupplierInvoiceFile"("tenantId", "companyId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceFile_tenantId_id_key" ON "SupplierInvoiceFile"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SdiInboxItem_tenantId_companyId_status_idx" ON "SdiInboxItem"("tenantId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SdiInboxItem_tenantId_sdiIdentifier_key" ON "SdiInboxItem"("tenantId", "sdiIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "InterestReferenceRate_tenantId_halfYearStart_key" ON "InterestReferenceRate"("tenantId", "halfYearStart");

-- CreateIndex
CREATE INDEX "PurchasingSettings_tenantId_companyId_idx" ON "PurchasingSettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "Inspection_tenantId_status_dueAt_idx" ON "Inspection"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_tenantId_carriedFromId_key" ON "PaymentAllocation"("tenantId", "carriedFromId");

-- CreateIndex
CREATE UNIQUE INDEX "QualityHold_tenantId_number_key" ON "QualityHold"("tenantId", "number");

-- CreateIndex
CREATE INDEX "SupplierInvoice_tenantId_sdiFileId_idx" ON "SupplierInvoice"("tenantId", "sdiFileId");

-- CreateIndex
CREATE INDEX "SupplierInvoice_tenantId_claimId_idx" ON "SupplierInvoice"("tenantId", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_sdiIdentifier_sdiBodyIndex_key" ON "SupplierInvoice"("tenantId", "sdiIdentifier", "sdiBodyIndex");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_number_voided_key" ON "SupplierInvoice"("tenantId", "companyId", "partyId", "number", "issueDate", "voidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_id_key" ON "SupplierInvoice"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "CertificateRenewal" ADD CONSTRAINT "CertificateRenewal_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CertificateRenewal" ADD CONSTRAINT "CertificateRenewal_tenantId_newCertificateId_fkey" FOREIGN KEY ("tenantId", "newCertificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_paymentId_carriedFromId_fkey" FOREIGN KEY ("tenantId", "paymentId", "carriedFromId") REFERENCES "PaymentAllocation"("tenantId", "paymentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_companyId_partyId_sdiFileId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "sdiFileId") REFERENCES "SupplierInvoiceFile"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_tenantId_claimSiteId_partyId_claimId_fkey" FOREIGN KEY ("tenantId", "claimSiteId", "partyId", "claimId") REFERENCES "SupplierClaim"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayablesSettings" ADD CONSTRAINT "PayablesSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceFile" ADD CONSTRAINT "SupplierInvoiceFile_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceFile" ADD CONSTRAINT "SupplierInvoiceFile_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceFile" ADD CONSTRAINT "SupplierInvoiceFile_tenantId_xmlFileId_fkey" FOREIGN KEY ("tenantId", "xmlFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiInboxItem" ADD CONSTRAINT "SdiInboxItem_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiInboxItem" ADD CONSTRAINT "SdiInboxItem_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiInboxItem" ADD CONSTRAINT "SdiInboxItem_tenantId_xmlFileId_fkey" FOREIGN KEY ("tenantId", "xmlFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiInboxItem" ADD CONSTRAINT "SdiInboxItem_tenantId_supplierInvoiceId_fkey" FOREIGN KEY ("tenantId", "supplierInvoiceId") REFERENCES "SupplierInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SdiInboxItem" ADD CONSTRAINT "SdiInboxItem_tenantId_supplierInvoiceFileId_fkey" FOREIGN KEY ("tenantId", "supplierInvoiceFileId") REFERENCES "SupplierInvoiceFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchasingSettings" ADD CONSTRAINT "PurchasingSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

