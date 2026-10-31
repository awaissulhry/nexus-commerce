-- CreateEnum
CREATE TYPE "PieceRateChangeReason" AS ENUM ('NEW', 'METHOD_CHANGED', 'EQUIPMENT_CHANGED', 'CORRECTION');

-- CreateEnum
CREATE TYPE "PieceRateVersionStatus" AS ENUM ('DRAFT', 'PROVISIONAL', 'PUBLISHED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PieceRateBasis" AS ENUM ('SMV_RATE', 'FIXED');

-- CreateEnum
CREATE TYPE "RatePublicationStatus" AS ENUM ('PUBLISHED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RateAckChannel" AS ENUM ('DEVICE', 'PAPER');

-- CreateEnum
CREATE TYPE "IncentiveKind" AS ENUM ('PIECE_RATE', 'STANDARD_MINUTE_BONUS', 'TEAM_INCENTIVE');

-- CreateEnum
CREATE TYPE "GuaranteedPayBasis" AS ENUM ('UNDECIDED', 'CCNL_MINIMUM', 'AGREED_HOURLY');

-- CreateEnum
CREATE TYPE "TeamSplitBasis" AS ENUM ('HOURS_PRESENT', 'SKILL_WEIGHT');

-- CreateEnum
CREATE TYPE "OwnFaultPay" AS ENUM ('UNPAID', 'REDUCED_RATE', 'FULL_RATE');

-- CreateEnum
CREATE TYPE "PaidTimeRate" AS ENUM ('AVERAGE', 'GUARANTEED');

-- CreateEnum
CREATE TYPE "IncentiveSchemeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "PiecePayState" AS ENUM ('OFF', 'ON');

-- CreateEnum
CREATE TYPE "PayPeriodStatus" AS ENUM ('OPEN', 'PREVIEW', 'REVIEW', 'LOCKED');

-- CreateEnum
CREATE TYPE "EarningsKind" AS ENUM ('SCAN', 'TEAM_SPLIT', 'MAKE_UP', 'OFF_STANDARD', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "HeldScanReason" AS ENUM ('NOT_CLOCKED_IN', 'ON_BREAK');

-- CreateEnum
CREATE TYPE "HeldScanStatus" AS ENUM ('OPEN', 'COUNTED', 'NOT_PAID');

-- CreateEnum
CREATE TYPE "WorkerStatementStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PayrollFileFormat" AS ENUM ('DELIMITED', 'SPREADSHEET', 'FIXED_WIDTH');

-- CreateEnum
CREATE TYPE "PayrollExportStatus" AS ENUM ('DRAFT', 'EXPORTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollExportFileKind" AS ENUM ('DATA', 'SUMMARY');

-- CreateEnum
CREATE TYPE "PayrollCodeKind" AS ENUM ('HOUR', 'ABSENCE', 'EARNING');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'PAYROLL_EXPORT';

-- CreateTable
CREATE TABLE "PieceRateTable" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "styleId" UUID,
    "lineId" UUID,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PieceRateTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PieceRateVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "changeReason" "PieceRateChangeReason" NOT NULL,
    "changeNote" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "trialEndsOn" DATE,
    "status" "PieceRateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedById" UUID,
    "supersededAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PieceRateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PieceRateEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "sizeBand" TEXT NOT NULL DEFAULT 'ALL',
    "basis" "PieceRateBasis" NOT NULL,
    "standardMinutes" DECIMAL(10,3),
    "ratePerMinute" DECIMAL(18,6),
    "ratePerPiece" DECIMAL(18,6) NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PieceRateEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatePublication" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "lineId" UUID,
    "workerIds" UUID[],
    "onFloor" BOOLEAN NOT NULL DEFAULT true,
    "printed" BOOLEAN NOT NULL DEFAULT false,
    "sheetFileId" UUID,
    "status" "RatePublicationStatus" NOT NULL DEFAULT 'PUBLISHED',
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedById" UUID NOT NULL,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,
    "withdrawReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RatePublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateAcknowledgement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "publicationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "channel" "RateAckChannel" NOT NULL,
    "deviceId" UUID,
    "deviceTime" TIMESTAMPTZ(3),
    "clientEventId" TEXT,
    "paperFileId" UUID,
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RateAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncentiveScheme" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "lineId" UUID,
    "name" TEXT NOT NULL,
    "kind" "IncentiveKind" NOT NULL,
    "efficiencyThresholdPct" DECIMAL(7,4),
    "guaranteedBasis" "GuaranteedPayBasis" NOT NULL DEFAULT 'UNDECIDED',
    "guaranteedHourlyRate" DECIMAL(18,6),
    "traineeHourlyRate" DECIMAL(18,6),
    "teamSplit" "TeamSplitBasis",
    "reworkOwnFault" "OwnFaultPay" NOT NULL DEFAULT 'UNPAID',
    "scrapOwnFault" "OwnFaultPay" NOT NULL DEFAULT 'UNPAID',
    "ownFaultRatePct" DECIMAL(7,4),
    "othersFaultPay" "PaidTimeRate" NOT NULL DEFAULT 'AVERAGE',
    "waitingPay" "PaidTimeRate" NOT NULL DEFAULT 'AVERAGE',
    "payOnlyWhileClockedIn" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "status" "IncentiveSchemeStatus" NOT NULL DEFAULT 'DRAFT',
    "activatedAt" TIMESTAMPTZ(3),
    "activatedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IncentiveScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PiecePaySwitch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "state" "PiecePayState" NOT NULL DEFAULT 'OFF',
    "ccnlName" TEXT,
    "ccnlArticle" TEXT,
    "workerNoticeId" UUID,
    "dpiaId" UUID,
    "consultantName" TEXT,
    "consultantAgreedOn" DATE,
    "schemeId" UUID,
    "preconditionsNote" TEXT,
    "onFrom" DATE,
    "switchedOnAt" TIMESTAMPTZ(3),
    "switchedOnById" UUID,
    "offFrom" DATE,
    "switchedOffAt" TIMESTAMPTZ(3),
    "switchedOffById" UUID,
    "offReason" TEXT,
    "earlierWindows" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PiecePaySwitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayPeriod" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "PayPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "previewedAt" TIMESTAMPTZ(3),
    "previewedById" UUID,
    "reviewStartedAt" TIMESTAMPTZ(3),
    "reviewStartedById" UUID,
    "lockedAt" TIMESTAMPTZ(3),
    "lockedById" UUID,
    "lockNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PayPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningsEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "payPeriodId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "kind" "EarningsKind" NOT NULL,
    "operationScanId" UUID,
    "rateEntryId" UUID,
    "pieces" INTEGER,
    "minutes" DECIMAL(10,3),
    "rate" DECIMAL(18,6),
    "sharePct" DECIMAL(7,4),
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "heldScanId" UUID,
    "sourceType" TEXT,
    "sourceId" UUID,
    "correctsPeriodId" UUID,
    "reversalOfId" UUID,
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "EarningsEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeldScan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "payPeriodId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "operationScanId" UUID NOT NULL,
    "reason" "HeldScanReason" NOT NULL,
    "heldAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "HeldScanStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "resolutionNote" TEXT,
    "fixRecordType" TEXT,
    "fixRecordId" UUID,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HeldScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerStatement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "payPeriodId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "WorkerStatementStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" JSONB,
    "earningsAmount" INTEGER,
    "makeUpAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "fileId" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "supersededAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkerStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollExportLayout" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" "PayrollFileFormat" NOT NULL,
    "provider" TEXT,
    "definition" JSONB NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PayrollExportLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollExport" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payPeriodId" UUID,
    "layoutId" UUID NOT NULL,
    "layoutSnapshot" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "correctionOfId" UUID,
    "numberSeriesId" UUID,
    "number" TEXT,
    "status" "PayrollExportStatus" NOT NULL DEFAULT 'DRAFT',
    "checks" JSONB NOT NULL DEFAULT '[]',
    "values" JSONB NOT NULL DEFAULT '[]',
    "exportedAt" TIMESTAMPTZ(3),
    "exportedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PayrollExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollExportFile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "exportId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "PayrollExportFileKind" NOT NULL,
    "fileId" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PayrollExportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollCodeMapping" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "kind" "PayrollCodeKind" NOT NULL,
    "ourCode" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,
    "providerCode" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PayrollCodeMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PieceRateTable_tenantId_siteId_code_key" ON "PieceRateTable"("tenantId", "siteId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PieceRateTable_tenantId_companyId_siteId_id_key" ON "PieceRateTable"("tenantId", "companyId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PieceRateVersion_tenantId_tableId_versionNo_key" ON "PieceRateVersion"("tenantId", "tableId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "PieceRateVersion_tenantId_siteId_id_key" ON "PieceRateVersion"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PieceRateVersion_tenantId_companyId_siteId_id_key" ON "PieceRateVersion"("tenantId", "companyId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PieceRateEntry_tenantId_versionId_operationId_sizeBand_key" ON "PieceRateEntry"("tenantId", "versionId", "operationId", "sizeBand");

-- CreateIndex
CREATE UNIQUE INDEX "PieceRateEntry_tenantId_siteId_id_key" ON "PieceRateEntry"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "RatePublication_tenantId_versionId_idx" ON "RatePublication"("tenantId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "RatePublication_tenantId_siteId_id_key" ON "RatePublication"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "RateAcknowledgement_tenantId_publicationId_employeeId_idx" ON "RateAcknowledgement"("tenantId", "publicationId", "employeeId");

-- CreateIndex
CREATE INDEX "RateAcknowledgement_tenantId_employeeId_idx" ON "RateAcknowledgement"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "RateAcknowledgement_tenantId_deviceId_clientEventId_key" ON "RateAcknowledgement"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE INDEX "IncentiveScheme_tenantId_companyId_validFrom_idx" ON "IncentiveScheme"("tenantId", "companyId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "IncentiveScheme_tenantId_companyId_id_key" ON "IncentiveScheme"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "PiecePaySwitch_tenantId_siteId_idx" ON "PiecePaySwitch"("tenantId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "PayPeriod_tenantId_companyId_periodStart_periodEnd_key" ON "PayPeriod"("tenantId", "companyId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "PayPeriod_tenantId_companyId_id_key" ON "PayPeriod"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "EarningsEntry_tenantId_payPeriodId_employeeId_idx" ON "EarningsEntry"("tenantId", "payPeriodId", "employeeId");

-- CreateIndex
CREATE INDEX "EarningsEntry_tenantId_operationScanId_idx" ON "EarningsEntry"("tenantId", "operationScanId");

-- CreateIndex
CREATE UNIQUE INDEX "EarningsEntry_tenantId_idempotencyKey_key" ON "EarningsEntry"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "EarningsEntry_tenantId_siteId_id_key" ON "EarningsEntry"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "HeldScan_tenantId_payPeriodId_status_idx" ON "HeldScan"("tenantId", "payPeriodId", "status");

-- CreateIndex
CREATE INDEX "HeldScan_tenantId_operationScanId_idx" ON "HeldScan"("tenantId", "operationScanId");

-- CreateIndex
CREATE UNIQUE INDEX "HeldScan_tenantId_key_key" ON "HeldScan"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "HeldScan_tenantId_siteId_id_key" ON "HeldScan"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "WorkerStatement_tenantId_employeeId_idx" ON "WorkerStatement"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerStatement_tenantId_payPeriodId_employeeId_revision_key" ON "WorkerStatement"("tenantId", "payPeriodId", "employeeId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExportLayout_tenantId_companyId_name_key" ON "PayrollExportLayout"("tenantId", "companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExportLayout_tenantId_companyId_id_key" ON "PayrollExportLayout"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "PayrollExport_tenantId_companyId_periodStart_idx" ON "PayrollExport"("tenantId", "companyId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExport_tenantId_companyId_number_key" ON "PayrollExport"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExport_tenantId_id_key" ON "PayrollExport"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExport_tenantId_companyId_id_key" ON "PayrollExport"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExportFile_tenantId_exportId_seq_key" ON "PayrollExportFile"("tenantId", "exportId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCodeMapping_tenantId_companyId_kind_ourCode_key" ON "PayrollCodeMapping"("tenantId", "companyId", "kind", "ourCode");

-- AddForeignKey
ALTER TABLE "PieceRateTable" ADD CONSTRAINT "PieceRateTable_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PieceRateTable" ADD CONSTRAINT "PieceRateTable_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PieceRateTable" ADD CONSTRAINT "PieceRateTable_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PieceRateVersion" ADD CONSTRAINT "PieceRateVersion_tenantId_companyId_siteId_tableId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "tableId") REFERENCES "PieceRateTable"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PieceRateEntry" ADD CONSTRAINT "PieceRateEntry_tenantId_siteId_versionId_fkey" FOREIGN KEY ("tenantId", "siteId", "versionId") REFERENCES "PieceRateVersion"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PieceRateEntry" ADD CONSTRAINT "PieceRateEntry_tenantId_operationId_fkey" FOREIGN KEY ("tenantId", "operationId") REFERENCES "Operation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RatePublication" ADD CONSTRAINT "RatePublication_tenantId_companyId_siteId_versionId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "versionId") REFERENCES "PieceRateVersion"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RatePublication" ADD CONSTRAINT "RatePublication_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RatePublication" ADD CONSTRAINT "RatePublication_tenantId_sheetFileId_fkey" FOREIGN KEY ("tenantId", "sheetFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RateAcknowledgement" ADD CONSTRAINT "RateAcknowledgement_tenantId_siteId_publicationId_fkey" FOREIGN KEY ("tenantId", "siteId", "publicationId") REFERENCES "RatePublication"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RateAcknowledgement" ADD CONSTRAINT "RateAcknowledgement_tenantId_siteId_versionId_fkey" FOREIGN KEY ("tenantId", "siteId", "versionId") REFERENCES "PieceRateVersion"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RateAcknowledgement" ADD CONSTRAINT "RateAcknowledgement_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RateAcknowledgement" ADD CONSTRAINT "RateAcknowledgement_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RateAcknowledgement" ADD CONSTRAINT "RateAcknowledgement_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RateAcknowledgement" ADD CONSTRAINT "RateAcknowledgement_tenantId_paperFileId_fkey" FOREIGN KEY ("tenantId", "paperFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncentiveScheme" ADD CONSTRAINT "IncentiveScheme_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IncentiveScheme" ADD CONSTRAINT "IncentiveScheme_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PiecePaySwitch" ADD CONSTRAINT "PiecePaySwitch_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PiecePaySwitch" ADD CONSTRAINT "PiecePaySwitch_tenantId_companyId_workerNoticeId_fkey" FOREIGN KEY ("tenantId", "companyId", "workerNoticeId") REFERENCES "PrivacyNotice"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PiecePaySwitch" ADD CONSTRAINT "PiecePaySwitch_tenantId_dpiaId_fkey" FOREIGN KEY ("tenantId", "dpiaId") REFERENCES "PrivacyDpia"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PiecePaySwitch" ADD CONSTRAINT "PiecePaySwitch_tenantId_companyId_schemeId_fkey" FOREIGN KEY ("tenantId", "companyId", "schemeId") REFERENCES "IncentiveScheme"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayPeriod" ADD CONSTRAINT "PayPeriod_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_companyId_payPeriodId_fkey" FOREIGN KEY ("tenantId", "companyId", "payPeriodId") REFERENCES "PayPeriod"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_siteId_operationScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "operationScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_siteId_rateEntryId_fkey" FOREIGN KEY ("tenantId", "siteId", "rateEntryId") REFERENCES "PieceRateEntry"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_siteId_heldScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "heldScanId") REFERENCES "HeldScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_companyId_correctsPeriodId_fkey" FOREIGN KEY ("tenantId", "companyId", "correctsPeriodId") REFERENCES "PayPeriod"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EarningsEntry" ADD CONSTRAINT "EarningsEntry_tenantId_siteId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "siteId", "reversalOfId") REFERENCES "EarningsEntry"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HeldScan" ADD CONSTRAINT "HeldScan_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HeldScan" ADD CONSTRAINT "HeldScan_tenantId_companyId_payPeriodId_fkey" FOREIGN KEY ("tenantId", "companyId", "payPeriodId") REFERENCES "PayPeriod"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HeldScan" ADD CONSTRAINT "HeldScan_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HeldScan" ADD CONSTRAINT "HeldScan_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HeldScan" ADD CONSTRAINT "HeldScan_tenantId_siteId_operationScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "operationScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerStatement" ADD CONSTRAINT "WorkerStatement_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerStatement" ADD CONSTRAINT "WorkerStatement_tenantId_companyId_payPeriodId_fkey" FOREIGN KEY ("tenantId", "companyId", "payPeriodId") REFERENCES "PayPeriod"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerStatement" ADD CONSTRAINT "WorkerStatement_tenantId_companyId_employeeId_fkey" FOREIGN KEY ("tenantId", "companyId", "employeeId") REFERENCES "Employee"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerStatement" ADD CONSTRAINT "WorkerStatement_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExportLayout" ADD CONSTRAINT "PayrollExportLayout_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExport" ADD CONSTRAINT "PayrollExport_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExport" ADD CONSTRAINT "PayrollExport_tenantId_companyId_payPeriodId_fkey" FOREIGN KEY ("tenantId", "companyId", "payPeriodId") REFERENCES "PayPeriod"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExport" ADD CONSTRAINT "PayrollExport_tenantId_companyId_layoutId_fkey" FOREIGN KEY ("tenantId", "companyId", "layoutId") REFERENCES "PayrollExportLayout"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExport" ADD CONSTRAINT "PayrollExport_tenantId_companyId_numberSeriesId_fkey" FOREIGN KEY ("tenantId", "companyId", "numberSeriesId") REFERENCES "NumberSeries"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExport" ADD CONSTRAINT "PayrollExport_tenantId_companyId_correctionOfId_fkey" FOREIGN KEY ("tenantId", "companyId", "correctionOfId") REFERENCES "PayrollExport"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExportFile" ADD CONSTRAINT "PayrollExportFile_tenantId_exportId_fkey" FOREIGN KEY ("tenantId", "exportId") REFERENCES "PayrollExport"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollExportFile" ADD CONSTRAINT "PayrollExportFile_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayrollCodeMapping" ADD CONSTRAINT "PayrollCodeMapping_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

