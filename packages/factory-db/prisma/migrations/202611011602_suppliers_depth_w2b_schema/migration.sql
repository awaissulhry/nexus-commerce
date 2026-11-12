-- CreateEnum
CREATE TYPE "SupplierKind" AS ENUM ('TANNERY', 'TEXTILE_MILL', 'TRIMS', 'PROTECTOR_MAKER', 'SUBCONTRACTOR', 'CARRIER', 'SERVICE');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('PROSPECT', 'APPROVED', 'CONDITIONAL', 'ON_HOLD', 'BLOCKED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PartyContactReceives" AS ENUM ('PO', 'CLAIM', 'REMITTANCE', 'QUALITY', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "SupplierBankAccountStatus" AS ENUM ('PROPOSED', 'VERIFIED', 'ACTIVE', 'REFUSED', 'RETIRED');

-- CreateEnum
CREATE TYPE "SupplierQualificationStatus" AS ENUM ('PENDING', 'APPROVED', 'CONDITIONAL', 'REFUSED', 'SUSPENDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SubcontractAgreementStatus" AS ENUM ('DRAFT', 'SIGNED', 'SUPERSEDED', 'TERMINATED');

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "hideOriginCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "originCountry" TEXT,
ADD COLUMN     "originNote" TEXT,
ADD COLUMN     "originRegion" TEXT,
ADD COLUMN     "supplierKinds" "SupplierKind"[] DEFAULT ARRAY[]::"SupplierKind"[],
ADD COLUMN     "supplierStatus" "SupplierStatus",
ADD COLUMN     "supplierStatusChangedAt" TIMESTAMPTZ(3),
ADD COLUMN     "supplierStatusChangedById" UUID,
ADD COLUMN     "supplierStatusReason" TEXT,
ADD COLUMN     "tannages" "Tannage"[] DEFAULT ARRAY[]::"Tannage"[];

-- AlterTable
ALTER TABLE "PartyContact" ADD COLUMN     "receives" "PartyContactReceives"[] DEFAULT ARRAY[]::"PartyContactReceives"[];

-- CreateTable
CREATE TABLE "SupplierBankAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "iban" TEXT NOT NULL,
    "ibanCountry" TEXT NOT NULL DEFAULT '',
    "ibanLast4" TEXT NOT NULL DEFAULT '',
    "bic" TEXT,
    "bankName" TEXT,
    "holder" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "SupplierBankAccountStatus" NOT NULL DEFAULT 'PROPOSED',
    "replacesId" UUID,
    "proposedById" UUID NOT NULL,
    "proposedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "callBackAt" TIMESTAMPTZ(3),
    "callBackById" UUID,
    "callBackContactId" UUID,
    "callBackAddressId" UUID,
    "callBackPhone" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "verifiedById" UUID,
    "activatedAt" TIMESTAMPTZ(3),
    "refusedAt" TIMESTAMPTZ(3),
    "refusedById" UUID,
    "refuseReason" TEXT,
    "retiredAt" TIMESTAMPTZ(3),
    "retireReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierQualification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "workCentreKinds" "WorkCentreKind"[] DEFAULT ARRAY[]::"WorkCentreKind"[],
    "operationIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "materialKinds" "ItemKind"[] DEFAULT ARRAY[]::"ItemKind"[],
    "status" "SupplierQualificationStatus" NOT NULL DEFAULT 'PENDING',
    "validFrom" DATE,
    "validUntil" DATE,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "conditions" TEXT,
    "refuseReason" TEXT,
    "suspendedAt" TIMESTAMPTZ(3),
    "suspendReason" TEXT,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractAgreement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "termsFileId" UUID,
    "status" "SubcontractAgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "signedAt" TIMESTAMPTZ(3),
    "validFrom" DATE NOT NULL,
    "validUntil" DATE,
    "endedAt" TIMESTAMPTZ(3),
    "endReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierBankAccount_tenantId_partyId_status_idx" ON "SupplierBankAccount"("tenantId", "partyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBankAccount_tenantId_partyId_id_key" ON "SupplierBankAccount"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "SupplierQualification_tenantId_partyId_status_idx" ON "SupplierQualification"("tenantId", "partyId", "status");

-- CreateIndex
CREATE INDEX "SupplierQualification_tenantId_companyId_status_idx" ON "SupplierQualification"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "SubcontractAgreement_tenantId_partyId_status_idx" ON "SubcontractAgreement"("tenantId", "partyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractAgreement_tenantId_companyId_partyId_revision_key" ON "SubcontractAgreement"("tenantId", "companyId", "partyId", "revision");

-- AddForeignKey
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_tenantId_partyId_replacesId_fkey" FOREIGN KEY ("tenantId", "partyId", "replacesId") REFERENCES "SupplierBankAccount"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_tenantId_partyId_callBackContactId_fkey" FOREIGN KEY ("tenantId", "partyId", "callBackContactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_tenantId_partyId_callBackAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "callBackAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierQualification" ADD CONSTRAINT "SupplierQualification_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierQualification" ADD CONSTRAINT "SupplierQualification_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractAgreement" ADD CONSTRAINT "SubcontractAgreement_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractAgreement" ADD CONSTRAINT "SubcontractAgreement_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractAgreement" ADD CONSTRAINT "SubcontractAgreement_tenantId_termsFileId_fkey" FOREIGN KEY ("tenantId", "termsFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

