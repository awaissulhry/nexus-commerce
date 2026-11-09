-- CreateEnum
CREATE TYPE "RegulationKind" AS ENUM ('REGULATION', 'DIRECTIVE', 'HARMONISED_STANDARD', 'STANDARD', 'NATIONAL_LAW', 'GUIDANCE');

-- CreateEnum
CREATE TYPE "RegulationStatus" AS ENUM ('IN_FORCE', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "StandardChangeKind" AS ENUM ('REVISION', 'AMENDMENT', 'WITHDRAWAL', 'NEW_CITATION', 'OTHER');

-- CreateEnum
CREATE TYPE "StandardChangeStatus" AS ENUM ('OPEN', 'ASSESSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "StandardChangeImpact" AS ENUM ('NONE', 'REVIEW', 'RETEST');

-- CreateEnum
CREATE TYPE "ComplianceRequirementKind" AS ENUM ('CERTIFICATE', 'DOC_LANGUAGE', 'USER_INFO_LANGUAGE', 'LABEL', 'TEST', 'OPERATOR_ROLE', 'DECLARATION', 'CLAIM_EVIDENCE');

-- CreateEnum
CREATE TYPE "ComplianceGate" AS ENUM ('WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT');

-- CreateEnum
CREATE TYPE "GateOutcome" AS ENUM ('REFUSED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "EconomicOperatorKind" AS ENUM ('MANUFACTURER', 'AUTHORISED_REPRESENTATIVE', 'IMPORTER', 'DISTRIBUTOR', 'FULFILMENT');

-- CreateEnum
CREATE TYPE "PhraseKind" AS ENUM ('WARNING', 'CARE', 'MARKING', 'DOC', 'USER_INFO', 'CLAIM');

-- CreateEnum
CREATE TYPE "PhraseTranslationStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN     "baseCertificateId" UUID,
ADD COLUMN     "notifiedBodyId" UUID,
ADD COLUMN     "performanceLevels" JSONB;

-- AlterTable
ALTER TABLE "CertificateCoverage" ADD COLUMN     "supplierArticleCode" TEXT,
ADD COLUMN     "supplierPartyId" UUID;

-- CreateTable
CREATE TABLE "RegulationOrStandard" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "code" TEXT NOT NULL,
    "edition" TEXT,
    "title" TEXT NOT NULL,
    "titleI18n" JSONB,
    "kind" "RegulationKind" NOT NULL,
    "status" "RegulationStatus" NOT NULL DEFAULT 'IN_FORCE',
    "ojReference" TEXT,
    "ojDate" DATE,
    "supersededById" UUID,
    "link" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RegulationOrStandard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandardChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "standardId" UUID NOT NULL,
    "newStandardId" UUID,
    "kind" "StandardChangeKind" NOT NULL,
    "whatChanged" TEXT NOT NULL,
    "sourceReference" TEXT,
    "noticedAt" TIMESTAMPTZ(3) NOT NULL,
    "noticedById" UUID,
    "transitionEndsOn" DATE,
    "status" "StandardChangeStatus" NOT NULL DEFAULT 'OPEN',
    "impact" "StandardChangeImpact",
    "assessment" TEXT,
    "assessedAt" TIMESTAMPTZ(3),
    "assessedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "certificateIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "typeChangeReviewIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "taskId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StandardChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "labelLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "docLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userInfoLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "markings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nationalRules" JSONB NOT NULL DEFAULT '[]',
    "importerNeeded" BOOLEAN NOT NULL DEFAULT false,
    "gpsrContactNeeded" BOOLEAN NOT NULL DEFAULT false,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "switchedOn" BOOLEAN NOT NULL DEFAULT true,
    "offReason" TEXT,
    "switchedAt" TIMESTAMPTZ(3),
    "switchedById" UUID,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MarketProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRequirement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "kind" "ComplianceRequirementKind" NOT NULL,
    "checkKey" TEXT,
    "operatorRole" "EconomicOperatorKind",
    "productTypes" "ProductType"[] DEFAULT ARRAY[]::"ProductType"[],
    "productTypeProfileId" UUID,
    "ppeCategories" "PpeCategory"[] DEFAULT ARRAY[]::"PpeCategory"[],
    "marketCode" TEXT,
    "blocks" "ComplianceGate"[] DEFAULT ARRAY[]::"ComplianceGate"[],
    "lockedBlocks" "ComplianceGate"[] DEFAULT ARRAY[]::"ComplianceGate"[],
    "overrideRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "overrideMaxDays" INTEGER NOT NULL DEFAULT 7,
    "legalReference" TEXT NOT NULL,
    "regulationId" UUID,
    "explanationI18n" JSONB,
    "appliesFrom" DATE,
    "appliesUntil" DATE,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "switchedOn" BOOLEAN NOT NULL DEFAULT true,
    "offReason" TEXT,
    "switchedAt" TIMESTAMPTZ(3),
    "switchedById" UUID,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ComplianceRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "gate" "ComplianceGate" NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "outcome" "GateOutcome" NOT NULL,
    "requirementId" UUID NOT NULL,
    "styleId" UUID,
    "marketCode" TEXT,
    "reason" TEXT NOT NULL,
    "explanation" JSONB,
    "refusedEventId" UUID,
    "stepUpAt" TIMESTAMPTZ(3),
    "overrideUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomicOperatorRole" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "styleId" UUID,
    "brandPartyId" UUID,
    "marketCode" TEXT,
    "role" "EconomicOperatorKind" NOT NULL,
    "partyId" UUID,
    "printedName" TEXT NOT NULL,
    "printedAddress" TEXT NOT NULL,
    "contact" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "EconomicOperatorRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Phrase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "key" TEXT NOT NULL,
    "kind" "PhraseKind" NOT NULL,
    "sourceLanguage" TEXT NOT NULL DEFAULT 'it',
    "sourceText" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Phrase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhraseTranslation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "phraseId" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" "PhraseTranslationStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceRevision" INTEGER NOT NULL,
    "translatedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PhraseTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotifiedBody" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "nandoUrl" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "NotifiedBody_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegulationOrStandard_tenantId_code_edition_key" ON "RegulationOrStandard"("tenantId", "code", "edition");

-- CreateIndex
CREATE UNIQUE INDEX "RegulationOrStandard_tenantId_id_key" ON "RegulationOrStandard"("tenantId", "id");

-- CreateIndex
CREATE INDEX "StandardChange_tenantId_standardId_idx" ON "StandardChange"("tenantId", "standardId");

-- CreateIndex
CREATE INDEX "StandardChange_tenantId_status_idx" ON "StandardChange"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketProfile_tenantId_code_key" ON "MarketProfile"("tenantId", "code");

-- CreateIndex
CREATE INDEX "ComplianceRequirement_tenantId_marketCode_idx" ON "ComplianceRequirement"("tenantId", "marketCode");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRequirement_tenantId_code_key" ON "ComplianceRequirement"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRequirement_tenantId_id_key" ON "ComplianceRequirement"("tenantId", "id");

-- CreateIndex
CREATE INDEX "GateEvent_tenantId_subjectType_subjectId_idx" ON "GateEvent"("tenantId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "GateEvent_tenantId_createdAt_idx" ON "GateEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "GateEvent_tenantId_requirementId_idx" ON "GateEvent"("tenantId", "requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "GateEvent_tenantId_id_key" ON "GateEvent"("tenantId", "id");

-- CreateIndex
CREATE INDEX "EconomicOperatorRole_tenantId_styleId_idx" ON "EconomicOperatorRole"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "EconomicOperatorRole_tenantId_brandPartyId_idx" ON "EconomicOperatorRole"("tenantId", "brandPartyId");

-- CreateIndex
CREATE INDEX "EconomicOperatorRole_tenantId_marketCode_idx" ON "EconomicOperatorRole"("tenantId", "marketCode");

-- CreateIndex
CREATE UNIQUE INDEX "Phrase_tenantId_key_key" ON "Phrase"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Phrase_tenantId_id_key" ON "Phrase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PhraseTranslation_tenantId_phraseId_language_revision_key" ON "PhraseTranslation"("tenantId", "phraseId", "language", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "NotifiedBody_tenantId_id_key" ON "NotifiedBody"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "RegulationOrStandard" ADD CONSTRAINT "RegulationOrStandard_tenantId_supersededById_fkey" FOREIGN KEY ("tenantId", "supersededById") REFERENCES "RegulationOrStandard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StandardChange" ADD CONSTRAINT "StandardChange_tenantId_standardId_fkey" FOREIGN KEY ("tenantId", "standardId") REFERENCES "RegulationOrStandard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StandardChange" ADD CONSTRAINT "StandardChange_tenantId_newStandardId_fkey" FOREIGN KEY ("tenantId", "newStandardId") REFERENCES "RegulationOrStandard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MarketProfile" ADD CONSTRAINT "MarketProfile_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceRequirement" ADD CONSTRAINT "ComplianceRequirement_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceRequirement" ADD CONSTRAINT "ComplianceRequirement_tenantId_productTypeProfileId_fkey" FOREIGN KEY ("tenantId", "productTypeProfileId") REFERENCES "ProductTypeProfile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ComplianceRequirement" ADD CONSTRAINT "ComplianceRequirement_tenantId_regulationId_fkey" FOREIGN KEY ("tenantId", "regulationId") REFERENCES "RegulationOrStandard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GateEvent" ADD CONSTRAINT "GateEvent_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GateEvent" ADD CONSTRAINT "GateEvent_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GateEvent" ADD CONSTRAINT "GateEvent_tenantId_requirementId_fkey" FOREIGN KEY ("tenantId", "requirementId") REFERENCES "ComplianceRequirement"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GateEvent" ADD CONSTRAINT "GateEvent_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GateEvent" ADD CONSTRAINT "GateEvent_tenantId_refusedEventId_fkey" FOREIGN KEY ("tenantId", "refusedEventId") REFERENCES "GateEvent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EconomicOperatorRole" ADD CONSTRAINT "EconomicOperatorRole_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EconomicOperatorRole" ADD CONSTRAINT "EconomicOperatorRole_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EconomicOperatorRole" ADD CONSTRAINT "EconomicOperatorRole_tenantId_brandPartyId_fkey" FOREIGN KEY ("tenantId", "brandPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EconomicOperatorRole" ADD CONSTRAINT "EconomicOperatorRole_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Phrase" ADD CONSTRAINT "Phrase_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PhraseTranslation" ADD CONSTRAINT "PhraseTranslation_tenantId_phraseId_fkey" FOREIGN KEY ("tenantId", "phraseId") REFERENCES "Phrase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_tenantId_notifiedBodyId_fkey" FOREIGN KEY ("tenantId", "notifiedBodyId") REFERENCES "NotifiedBody"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_tenantId_baseCertificateId_fkey" FOREIGN KEY ("tenantId", "baseCertificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CertificateCoverage" ADD CONSTRAINT "CertificateCoverage_tenantId_supplierPartyId_fkey" FOREIGN KEY ("tenantId", "supplierPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

