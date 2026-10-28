-- CreateEnum
CREATE TYPE "PartyKind" AS ENUM ('ORGANISATION', 'PERSON');

-- CreateEnum
CREATE TYPE "PartyRole" AS ENUM ('CUSTOMER', 'BRAND', 'SUPPLIER', 'SUBCONTRACTOR', 'CARRIER');

-- CreateEnum
CREATE TYPE "PartyStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'BLOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PartyAddressKind" AS ENUM ('REGISTERED', 'BILL_TO', 'SHIP_TO', 'PICKUP');

-- CreateEnum
CREATE TYPE "PartyContactRole" AS ENUM ('ORDERS', 'INVOICES', 'QUALITY', 'DESIGN', 'OWNER', 'RIDER');

-- CreateEnum
CREATE TYPE "PartyTaxMode" AS ENUM ('IT_B2B', 'IT_B2C', 'EU_B2B', 'EU_B2C', 'EXTRA_EU');

-- CreateEnum
CREATE TYPE "ViesCheckResult" AS ENUM ('VALID', 'INVALID', 'ERROR');

-- CreateTable
CREATE TABLE "Party" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "kind" "PartyKind" NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "roles" "PartyRole"[] DEFAULT ARRAY[]::"PartyRole"[],
    "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE',
    "country" TEXT NOT NULL DEFAULT 'IT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "language" TEXT NOT NULL DEFAULT 'it',
    "paymentTerms" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyAddress" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "kinds" "PartyAddressKind"[] DEFAULT ARRAY[]::"PartyAddressKind"[],
    "name" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "postalCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT,
    "country" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "deliveryNotes" TEXT,
    "isDefaultBillTo" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultShipTo" BOOLEAN NOT NULL DEFAULT false,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyContact" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "roles" "PartyContactRole"[] DEFAULT ARRAY[]::"PartyContactRole"[],
    "language" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyTaxIdentity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "country" TEXT NOT NULL,
    "taxMode" "PartyTaxMode" NOT NULL,
    "vatNumber" TEXT,
    "fiscalCode" TEXT,
    "sdiRecipientCode" TEXT,
    "pec" TEXT,
    "validFrom" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyTaxIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ViesCheck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "taxIdentityId" UUID NOT NULL,
    "companyId" UUID,
    "countryCode" TEXT NOT NULL,
    "vatNumber" TEXT NOT NULL,
    "requesterVatNumber" TEXT,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "result" "ViesCheckResult" NOT NULL,
    "consultationNumber" TEXT,
    "traderName" TEXT,
    "traderAddress" TEXT,
    "errorCode" TEXT,
    "responseSha256" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ViesCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "riderName" TEXT NOT NULL,
    "garmentType" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "supersedesId" UUID,
    "measurements" JSONB NOT NULL,
    "baseSize" TEXT,
    "fitNotes" TEXT,
    "internalNote" TEXT,
    "takenAt" TIMESTAMPTZ(3) NOT NULL,
    "takenBy" TEXT NOT NULL,
    "privacyNoticeRef" TEXT NOT NULL,
    "privacyNoticeAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MeasurementProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Party_tenantId_code_key" ON "Party"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Party_tenantId_id_key" ON "Party"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PartyAddress_tenantId_partyId_id_key" ON "PartyAddress"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "PartyContact_tenantId_email_idx" ON "PartyContact"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "PartyContact_tenantId_partyId_id_key" ON "PartyContact"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "PartyTaxIdentity_tenantId_vatNumber_idx" ON "PartyTaxIdentity"("tenantId", "vatNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PartyTaxIdentity_tenantId_partyId_validFrom_key" ON "PartyTaxIdentity"("tenantId", "partyId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PartyTaxIdentity_tenantId_partyId_id_key" ON "PartyTaxIdentity"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "ViesCheck_tenantId_taxIdentityId_requestedAt_idx" ON "ViesCheck"("tenantId", "taxIdentityId", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementProfile_tenantId_partyId_riderName_garmentType_r_key" ON "MeasurementProfile"("tenantId", "partyId", "riderName", "garmentType", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "MeasurementProfile_tenantId_partyId_id_key" ON "MeasurementProfile"("tenantId", "partyId", "id");

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyAddress" ADD CONSTRAINT "PartyAddress_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyContact" ADD CONSTRAINT "PartyContact_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyTaxIdentity" ADD CONSTRAINT "PartyTaxIdentity_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ViesCheck" ADD CONSTRAINT "ViesCheck_tenantId_partyId_taxIdentityId_fkey" FOREIGN KEY ("tenantId", "partyId", "taxIdentityId") REFERENCES "PartyTaxIdentity"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ViesCheck" ADD CONSTRAINT "ViesCheck_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_partyId_supersedesId_fkey" FOREIGN KEY ("tenantId", "partyId", "supersedesId") REFERENCES "MeasurementProfile"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

