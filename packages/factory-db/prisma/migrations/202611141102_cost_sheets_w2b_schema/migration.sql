-- CreateEnum
CREATE TYPE "CostSheetState" AS ENUM ('DRAFT', 'APPROVED', 'FROZEN');

-- CreateEnum
CREATE TYPE "CostSheetFreezeReason" AS ENUM ('SUPERSEDED', 'SEASON_CLOSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CostCategory" AS ENUM ('MATERIAL', 'LEATHER', 'LABOUR', 'OVERHEAD', 'SUBCONTRACT', 'FREIGHT', 'DUTY', 'PACKAGING', 'COMMISSION');

-- CreateEnum
CREATE TYPE "CostLineSource" AS ENUM ('BOM_LINE', 'ROUTING', 'PIECE_RATE', 'OVERHEAD_RULE', 'COSTING_SETTINGS', 'UPLIFT', 'LANDED_COST', 'PACKAGING', 'TYPED');

-- CreateEnum
CREATE TYPE "OverheadBasis" AS ENUM ('PERCENT_OF_LABOUR', 'PER_MINUTE', 'PER_UNIT', 'PER_MACHINE_HOUR');

-- CreateEnum
CREATE TYPE "UpliftTarget" AS ENUM ('MATERIAL', 'CATEGORY', 'WORKSHOP');

-- CreateEnum
CREATE TYPE "UpliftSource" AS ENUM ('TYPED', 'LANDED_COST');

-- AlterEnum
ALTER TYPE "ApprovalTaskKind" ADD VALUE 'COST_SHEET';

-- AlterTable
ALTER TABLE "CostingSettings" ADD COLUMN     "pieceRateLabour" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pieceRateLabourAt" TIMESTAMPTZ(3),
ADD COLUMN     "pieceRateLabourById" UUID;

-- AlterTable
ALTER TABLE "OptionValue" ADD COLUMN     "materialDelta" DECIMAL(18,6),
ADD COLUMN     "materialDeltaCurrency" TEXT,
ADD COLUMN     "minutesDelta" DECIMAL(10,3);

-- CreateTable
CREATE TABLE "CostSheet" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "seasonId" UUID,
    "key" TEXT NOT NULL,
    "sheetVersion" INTEGER NOT NULL,
    "basedOnId" UUID,
    "state" "CostSheetState" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL,
    "baseSize" TEXT NOT NULL,
    "targetPrice" DECIMAL(18,6),
    "targetMarginPct" DECIMAL(7,4),
    "sizeCurveId" UUID,
    "sizeWeights" JSONB,
    "inputs" JSONB,
    "note" TEXT,
    "approvalTaskId" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "frozenAt" TIMESTAMPTZ(3),
    "frozenById" UUID,
    "frozenReason" "CostSheetFreezeReason",
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CostSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostSheetLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "costSheetId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "category" "CostCategory" NOT NULL,
    "source" "CostLineSource" NOT NULL,
    "sourceRecordType" TEXT,
    "sourceRecordId" UUID,
    "itemId" UUID,
    "workCentreKind" "WorkCentreKind",
    "label" TEXT,
    "size" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom",
    "unitCost" DECIMAL(18,6) NOT NULL,
    "cost" DECIMAL(18,6) NOT NULL,
    "pct" DECIMAL(7,4),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CostSheetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeatherCostBasis" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "itemId" UUID NOT NULL,
    "styleId" UUID,
    "key" TEXT NOT NULL,
    "areaUnit" "Uom" NOT NULL,
    "expectedYieldPct" DECIMAL(7,4) NOT NULL,
    "gradeMix" JSONB NOT NULL,
    "validFrom" DATE NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LeatherCostBasis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverheadRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "key" TEXT NOT NULL,
    "basis" "OverheadBasis" NOT NULL,
    "workCentreKind" "WorkCentreKind",
    "value" DECIMAL(18,6) NOT NULL,
    "currency" TEXT,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OverheadRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostPerMinuteCalc" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "workCentreKind" "WorkCentreKind" NOT NULL,
    "siteId" UUID,
    "workCentreId" UUID,
    "key" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "directLabourCost" DECIMAL(18,6) NOT NULL,
    "availableMinutes" DECIMAL(18,4) NOT NULL,
    "indirectPerMinute" DECIMAL(18,6) NOT NULL,
    "overheadPerMinute" DECIMAL(18,6) NOT NULL,
    "costPerMinute" DECIMAL(18,6) NOT NULL,
    "minutesBasis" JSONB,
    "note" TEXT,
    "labourRateId" UUID,
    "appliedAt" TIMESTAMPTZ(3),
    "appliedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CostPerMinuteCalc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialCostUplift" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "target" "UpliftTarget" NOT NULL,
    "itemId" UUID,
    "itemKind" "ItemKind",
    "partyId" UUID,
    "key" TEXT NOT NULL,
    "source" "UpliftSource" NOT NULL DEFAULT 'TYPED',
    "freightPct" DECIMAL(7,4),
    "dutyPct" DECIMAL(7,4),
    "insurancePct" DECIMAL(7,4),
    "transportOutPerPiece" DECIMAL(18,6),
    "transportBackPerPiece" DECIMAL(18,6),
    "currency" TEXT,
    "landedFrom" DATE,
    "landedTo" DATE,
    "validFrom" DATE NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MaterialCostUplift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeWeight" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "seasonId" UUID,
    "key" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "weight" DECIMAL(9,4) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SizeWeight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CostSheet_tenantId_styleId_state_idx" ON "CostSheet"("tenantId", "styleId", "state");

-- CreateIndex
CREATE INDEX "CostSheet_tenantId_revisionId_idx" ON "CostSheet"("tenantId", "revisionId");

-- CreateIndex
CREATE INDEX "CostSheet_tenantId_companyId_seasonId_idx" ON "CostSheet"("tenantId", "companyId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "CostSheet_tenantId_key_sheetVersion_key" ON "CostSheet"("tenantId", "key", "sheetVersion");

-- CreateIndex
CREATE UNIQUE INDEX "CostSheet_tenantId_id_key" ON "CostSheet"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CostSheetLine_tenantId_itemId_idx" ON "CostSheetLine"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "CostSheetLine_tenantId_costSheetId_seq_key" ON "CostSheetLine"("tenantId", "costSheetId", "seq");

-- CreateIndex
CREATE INDEX "LeatherCostBasis_tenantId_itemId_idx" ON "LeatherCostBasis"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "LeatherCostBasis_tenantId_key_validFrom_key" ON "LeatherCostBasis"("tenantId", "key", "validFrom");

-- CreateIndex
CREATE INDEX "OverheadRule_tenantId_companyId_periodStart_idx" ON "OverheadRule"("tenantId", "companyId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "OverheadRule_tenantId_key_periodStart_key" ON "OverheadRule"("tenantId", "key", "periodStart");

-- CreateIndex
CREATE INDEX "CostPerMinuteCalc_tenantId_companyId_periodStart_idx" ON "CostPerMinuteCalc"("tenantId", "companyId", "periodStart");

-- CreateIndex
CREATE INDEX "MaterialCostUplift_tenantId_itemId_idx" ON "MaterialCostUplift"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialCostUplift_tenantId_key_validFrom_key" ON "MaterialCostUplift"("tenantId", "key", "validFrom");

-- CreateIndex
CREATE INDEX "SizeWeight_tenantId_styleId_idx" ON "SizeWeight"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "SizeWeight_tenantId_key_key" ON "SizeWeight"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "CostSheet" ADD CONSTRAINT "CostSheet_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostSheet" ADD CONSTRAINT "CostSheet_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostSheet" ADD CONSTRAINT "CostSheet_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostSheet" ADD CONSTRAINT "CostSheet_tenantId_companyId_seasonId_fkey" FOREIGN KEY ("tenantId", "companyId", "seasonId") REFERENCES "Season"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostSheet" ADD CONSTRAINT "CostSheet_tenantId_basedOnId_fkey" FOREIGN KEY ("tenantId", "basedOnId") REFERENCES "CostSheet"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostSheetLine" ADD CONSTRAINT "CostSheetLine_tenantId_costSheetId_fkey" FOREIGN KEY ("tenantId", "costSheetId") REFERENCES "CostSheet"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostSheetLine" ADD CONSTRAINT "CostSheetLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeatherCostBasis" ADD CONSTRAINT "LeatherCostBasis_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeatherCostBasis" ADD CONSTRAINT "LeatherCostBasis_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeatherCostBasis" ADD CONSTRAINT "LeatherCostBasis_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OverheadRule" ADD CONSTRAINT "OverheadRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostPerMinuteCalc" ADD CONSTRAINT "CostPerMinuteCalc_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostPerMinuteCalc" ADD CONSTRAINT "CostPerMinuteCalc_tenantId_siteId_workCentreId_fkey" FOREIGN KEY ("tenantId", "siteId", "workCentreId") REFERENCES "WorkCentre"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialCostUplift" ADD CONSTRAINT "MaterialCostUplift_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialCostUplift" ADD CONSTRAINT "MaterialCostUplift_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialCostUplift" ADD CONSTRAINT "MaterialCostUplift_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SizeWeight" ADD CONSTRAINT "SizeWeight_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SizeWeight" ADD CONSTRAINT "SizeWeight_tenantId_seasonId_fkey" FOREIGN KEY ("tenantId", "seasonId") REFERENCES "Season"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

